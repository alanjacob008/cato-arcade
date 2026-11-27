use anchor_lang::prelude::*;
use ephemeral_rollups_sdk::{
    anchor::{commit, delegate, ephemeral, vrf, vrf_callback},
    cpi::DelegateConfig,
    ephem::MagicIntentBundleBuilder,
    vrf::{
        self,
        instructions::{create_request_randomness_ix, RequestRandomnessParams},
        types::SerializableAccountMeta,
    },
};

declare_id!("FYrH8Zsey8799rw5tygGDfm5JX55Mersz3ArAufJCctE");
// Keep the devnet test signer separate from the production treasury configuration.
#[cfg(feature = "devnet")]
pub const ADMIN: Pubkey = pubkey!("EWFPbtH2Zeopd8ffK9W4L2UbxxY5ppFpwUgbybF6S7Lv");
#[cfg(not(feature = "devnet"))]
pub const ADMIN: Pubkey = pubkey!("C4xZVdouF6Qpd5PndLQe1HPYoBQBSqh7ag9nyXGahigg");
pub const ROLL_DOMAIN: u64 = 1u64 << 32;
pub const PENDING: u8 = 0;
pub const FULFILLED: u8 = 1;
pub const MAX_SPONSORED_REQUESTS: u16 = 500;
pub const MAX_SPONSOR_LIFETIME: i64 = 86_400;
pub const MAX_POOL_POLICY_LIFETIME: i64 = 7 * 86_400;
pub const MAX_POOL_DAILY_REQUESTS: u32 = 10_000;
pub const MAX_POOL_TOTAL_REQUESTS: u32 = 70_000;

// These accounts remain on Solana L1; no cashier/vault account is delegated to ER.
include!("cashier.rs");

// The cashier is explicitly devnet-only. Its dedicated settlement signer trusts
// the operator's ledger, is isolated from VRF delegates, and has payout caps.
#[ephemeral]
#[program]
pub mod claw_vrf_probe {
    use super::*;

    pub fn initialize_devnet_cashier(ctx: Context<InitializeDevnetCashier>, settlement: Pubkey,
        daily_limit: u64, max_claim: u64) -> Result<()> {
        cashier_initialize(ctx, settlement, daily_limit, max_claim)
    }

    pub fn deposit_devnet_tokens(ctx: Context<DepositDevnetTokens>, reference: [u8; 32], tier: u8,
        quantity: u16) -> Result<()> {
        cashier_deposit(ctx, reference, tier, quantity)
    }

    pub fn withdraw_devnet_winnings(ctx: Context<WithdrawDevnetWinnings>, reference: [u8; 32],
        amount: u64) -> Result<()> {
        cashier_withdraw(ctx, reference, amount)
    }

    pub fn pause_devnet_cashier(ctx: Context<PauseDevnetCashier>, paused: bool) -> Result<()> {
        require!(cfg!(feature = "devnet"), CashierError::DevnetOnly);
        ctx.accounts.cashier.paused = paused;
        Ok(())
    }

    pub fn initialize_er_pool_session(ctx: Context<InitializeErPoolSession>, delegate: Pubkey, validator: Pubkey,
        authorized_until: i64, batch_requests: u16, grant_seconds: i64, daily_limit: u32, total_limit: u32) -> Result<()> {
        *ctx.accounts.session = ErPoolSession::new(delegate, validator, authorized_until, batch_requests,
            grant_seconds, daily_limit, total_limit, Clock::get()?.unix_timestamp, ctx.bumps.session)?;
        Ok(())
    }

    pub fn delegate_er_pool_session(ctx: Context<DelegateErPoolSession>, delegate: Pubkey) -> Result<()> {
        require!(*ctx.accounts.session.owner == ID, ProbeError::InvalidSponsor);
        let data = ctx.accounts.session.try_borrow_data()?;
        let state = ErPoolSession::try_deserialize(&mut &data[..])?;
        require!(state.session.authority == ADMIN && state.session.delegate == delegate, ProbeError::InvalidSponsor);
        require!(state.session.validator == ctx.accounts.validator.key(), ProbeError::InvalidErValidator);
        require!(!state.session.has_attempt || state.session.attempt.status == FULFILLED, ProbeError::ErAttemptPending);
        let validator = state.session.validator;
        drop(data);
        ctx.accounts.delegate_session(&ctx.accounts.admin,
            &[b"er-pool", ADMIN.as_ref(), delegate.as_ref()],
            DelegateConfig { validator: Some(validator), ..Default::default() })?;
        Ok(())
    }

    pub fn request_er_pool_probe(ctx: Context<RequestErPoolProbe>, nonce: u64, box_count: u16,
        target_index: u16, threshold: u64, caller_seed: [u8; 32]) -> Result<()> {
        let clock = Clock::get()?;
        // Renewal and quota consumption are in the same atomic transaction as
        // the request. A failed CPI cannot consume quota or create a new draw.
        ctx.accounts.session.start(ctx.accounts.payer.key(), nonce, box_count, target_index,
            threshold, clock.unix_timestamp, clock.slot)?;
        let ix = create_request_randomness_ix(RequestRandomnessParams {
            payer: ctx.accounts.payer.key(), oracle_queue: ctx.accounts.oracle_queue.key(), callback_program_id: ID,
            callback_discriminator: instruction::ConsumeErPoolProbe::DISCRIMINATOR.to_vec(), caller_seed,
            accounts_metas: Some(vec![SerializableAccountMeta { pubkey: ctx.accounts.session.key(), is_signer: false, is_writable: true }]),
            callback_args: Some(nonce.to_le_bytes().to_vec()),
        });
        ctx.accounts.invoke_signed_vrf(&ctx.accounts.payer.to_account_info(), &ix)?;
        Ok(())
    }

    pub fn consume_er_pool_probe(ctx: Context<ConsumeErPoolProbe>, randomness: [u8; 32], nonce: u64) -> Result<()> {
        require!(ctx.accounts.session.session.has_attempt, ProbeError::WrongNonce);
        ctx.accounts.session.session.attempt.settle(randomness, nonce, Clock::get()?.slot)
    }

    // The delegate may only disable its own policy. It cannot unpause, extend,
    // raise limits, move treasury funds, or change program upgrade authority.
    pub fn pause_er_pool_session(ctx: Context<ManageErPoolSession>) -> Result<()> {
        ctx.accounts.session.paused = true;
        Ok(())
    }

    pub fn undelegate_er_pool_session(ctx: Context<UndelegateErPoolSession>) -> Result<()> {
        require!(ctx.accounts.session.paused, ProbeError::PoolPolicyMustPause);
        require!(!ctx.accounts.session.session.has_attempt || ctx.accounts.session.session.attempt.status == FULFILLED,
            ProbeError::ErAttemptPending);
        MagicIntentBundleBuilder::new(ctx.accounts.payer.to_account_info(), ctx.accounts.magic_context.to_account_info(),
            ctx.accounts.magic_program.to_account_info())
            .commit_and_undelegate(&[ctx.accounts.session.to_account_info()]).build_and_invoke()?;
        Ok(())
    }

    // Owner renewal runs only after return to L1. Existing nonce, receipt and
    // lifetime consumption are retained; a policy update cannot reset usage.
    pub fn update_er_pool_policy(ctx: Context<UpdateErPoolPolicy>, authorized_until: i64,
        batch_requests: u16, grant_seconds: i64, daily_limit: u32, total_limit: u32) -> Result<()> {
        let state = &mut ctx.accounts.session;
        require!(!state.session.has_attempt || state.session.attempt.status == FULFILLED, ProbeError::ErAttemptPending);
        state.update_policy(authorized_until, batch_requests, grant_seconds, daily_limit, total_limit,
            Clock::get()?.unix_timestamp)
    }

    pub fn grant_sponsor(ctx: Context<GrantSponsor>, delegate: Pubkey, expires_at: i64, requests: u16) -> Result<()> {
        let sponsor = &mut ctx.accounts.sponsor;
        sponsor.authorize(delegate, expires_at, requests, Clock::get()?.unix_timestamp)?;
        sponsor.authority = ADMIN;
        sponsor.bump = ctx.bumps.sponsor;
        Ok(())
    }

    pub fn revoke_sponsor(ctx: Context<RevokeSponsor>) -> Result<()> {
        ctx.accounts.sponsor.remaining = 0;
        Ok(())
    }
    pub fn renew_sponsor(ctx: Context<RevokeSponsor>, expires_at: i64, requests: u16) -> Result<()> {
        let delegate = ctx.accounts.sponsor.delegate;
        ctx.accounts.sponsor.authorize(delegate, expires_at, requests, Clock::get()?.unix_timestamp)
    }

    pub fn request_sponsored_probe(
        ctx: Context<RequestSponsoredProbe>, nonce: u64, box_count: u16,
        target_index: u16, threshold: u64, caller_seed: [u8; 32],
    ) -> Result<()> {
        validate_request(box_count, target_index, threshold)?;
        let clock = Clock::get()?;
        ctx.accounts.sponsor.consume(ctx.accounts.payer.key(), clock.unix_timestamp)?;
        let attempt = &mut ctx.accounts.attempt;
        attempt.authority = ctx.accounts.payer.key();
        attempt.nonce = nonce;
        attempt.box_count = box_count;
        attempt.target_index = target_index;
        attempt.threshold = threshold;
        attempt.requested_slot = clock.slot;
        attempt.bump = ctx.bumps.attempt;
        attempt.status = PENDING;
        let ix = create_request_randomness_ix(RequestRandomnessParams {
            payer: ctx.accounts.payer.key(), oracle_queue: ctx.accounts.oracle_queue.key(),
            callback_program_id: ID, callback_discriminator: instruction::ConsumeProbe::DISCRIMINATOR.to_vec(), caller_seed,
            accounts_metas: Some(vec![SerializableAccountMeta { pubkey: ctx.accounts.attempt.key(), is_signer: false, is_writable: true }]),
            callback_args: Some(nonce.to_le_bytes().to_vec()),
        });
        // Quota consumption, account creation and VRF request commit atomically.
        ctx.accounts.invoke_signed_vrf(&ctx.accounts.payer.to_account_info(), &ix)?;
        Ok(())
    }

    pub fn request_probe(
        ctx: Context<RequestProbe>,
        nonce: u64,
        box_count: u16,
        target_index: u16,
        threshold: u64,
        caller_seed: [u8; 32],
    ) -> Result<()> {
        validate_request(box_count, target_index, threshold)?;
        let attempt = &mut ctx.accounts.attempt;
        attempt.authority = ctx.accounts.payer.key();
        attempt.nonce = nonce;
        attempt.box_count = box_count;
        attempt.target_index = target_index;
        attempt.threshold = threshold;
        attempt.requested_slot = Clock::get()?.slot;
        attempt.bump = ctx.bumps.attempt;
        attempt.status = PENDING;

        let ix = create_request_randomness_ix(RequestRandomnessParams {
            payer: ctx.accounts.payer.key(),
            oracle_queue: ctx.accounts.oracle_queue.key(),
            callback_program_id: ID,
            callback_discriminator: instruction::ConsumeProbe::DISCRIMINATOR.to_vec(),
            caller_seed,
            accounts_metas: Some(vec![SerializableAccountMeta {
                pubkey: ctx.accounts.attempt.key(),
                is_signer: false,
                is_writable: true,
            }]),
            callback_args: Some(nonce.to_le_bytes().to_vec()),
        });
        // Account creation and the CPI commit atomically; failure leaves no pending attempt.
        ctx.accounts.invoke_signed_vrf(&ctx.accounts.payer.to_account_info(), &ix)?;
        Ok(())
    }

    pub fn consume_probe(
        ctx: Context<ConsumeProbe>,
        randomness: [u8; 32],
        nonce: u64,
    ) -> Result<()> {
        ctx.accounts.attempt.settle(randomness, nonce, Clock::get()?.slot)
    }

    pub fn initialize_er_session(ctx: Context<InitializeErSession>, delegate: Pubkey, validator: Pubkey,
        expires_at: i64, requests: u16) -> Result<()> {
        *ctx.accounts.session = ErSession::new(delegate, validator, expires_at, requests,
            Clock::get()?.unix_timestamp, ctx.bumps.session)?;
        Ok(())
    }

    pub fn renew_er_session(ctx: Context<RenewErSession>, expires_at: i64, requests: u16) -> Result<()> {
        let session = &mut ctx.accounts.session;
        require!(!session.has_attempt || session.attempt.status == FULFILLED, ProbeError::ErAttemptPending);
        let replacement = ErSession::new(session.delegate, session.validator, expires_at, requests,
            Clock::get()?.unix_timestamp, session.bump)?;
        session.expires_at = replacement.expires_at;
        session.remaining = replacement.remaining;
        Ok(())
    }

    pub fn delegate_er_session(ctx: Context<DelegateErSession>, delegate: Pubkey) -> Result<()> {
        require!(*ctx.accounts.session.owner == ID, ProbeError::InvalidSponsor);
        let data = ctx.accounts.session.try_borrow_data()?;
        let session = ErSession::try_deserialize(&mut &data[..])?;
        require!(session.authority == ADMIN && session.delegate == delegate, ProbeError::InvalidSponsor);
        require!(session.validator == ctx.accounts.validator.key(), ProbeError::InvalidErValidator);
        require!(!session.has_attempt || session.attempt.status == FULFILLED, ProbeError::ErAttemptPending);
        let validator = session.validator;
        drop(data);
        ctx.accounts.delegate_session(&ctx.accounts.admin,
            &[b"er-session", ADMIN.as_ref(), delegate.as_ref()],
            DelegateConfig { validator: Some(validator), ..Default::default() })?;
        Ok(())
    }

    pub fn request_er_probe(ctx: Context<RequestErProbe>, nonce: u64, box_count: u16,
        target_index: u16, threshold: u64, caller_seed: [u8; 32]) -> Result<()> {
        let clock = Clock::get()?;
        ctx.accounts.session.start(ctx.accounts.payer.key(), nonce, box_count, target_index,
            threshold, clock.unix_timestamp, clock.slot)?;
        let ix = create_request_randomness_ix(RequestRandomnessParams {
            payer: ctx.accounts.payer.key(), oracle_queue: ctx.accounts.oracle_queue.key(), callback_program_id: ID,
            callback_discriminator: instruction::ConsumeErProbe::DISCRIMINATOR.to_vec(), caller_seed,
            accounts_metas: Some(vec![SerializableAccountMeta { pubkey: ctx.accounts.session.key(), is_signer: false, is_writable: true }]),
            callback_args: Some(nonce.to_le_bytes().to_vec()),
        });
        ctx.accounts.invoke_signed_vrf(&ctx.accounts.payer.to_account_info(), &ix)?;
        Ok(())
    }

    pub fn consume_er_probe(ctx: Context<ConsumeErProbe>, randomness: [u8; 32], nonce: u64) -> Result<()> {
        require!(ctx.accounts.session.has_attempt, ProbeError::WrongNonce);
        ctx.accounts.session.attempt.settle(randomness, nonce, Clock::get()?.slot)
    }

    pub fn undelegate_er_session(ctx: Context<UndelegateErSession>) -> Result<()> {
        require!(!ctx.accounts.session.has_attempt || ctx.accounts.session.attempt.status == FULFILLED,
            ProbeError::ErAttemptPending);
        MagicIntentBundleBuilder::new(ctx.accounts.payer.to_account_info(), ctx.accounts.magic_context.to_account_info(),
            ctx.accounts.magic_program.to_account_info())
            .commit_and_undelegate(&[ctx.accounts.session.to_account_info()]).build_and_invoke()?;
        Ok(())
    }
}

#[derive(Accounts)]
#[instruction(delegate: Pubkey)]
pub struct InitializeErPoolSession<'info> {
    #[account(mut, address = ADMIN)]
    pub admin: Signer<'info>,
    #[account(init, payer = admin, space = 8 + ErPoolSession::SPACE,
        seeds = [b"er-pool", ADMIN.as_ref(), delegate.as_ref()], bump)]
    pub session: Account<'info, ErPoolSession>,
    pub system_program: Program<'info, System>,
}

#[delegate]
#[derive(Accounts)]
#[instruction(delegate: Pubkey)]
pub struct DelegateErPoolSession<'info> {
    #[account(mut, address = ADMIN)]
    pub admin: Signer<'info>,
    /// CHECK: Serialized owner, delegate, pending state and validator checked.
    #[account(mut, del, seeds = [b"er-pool", ADMIN.as_ref(), delegate.as_ref()], bump)]
    pub session: UncheckedAccount<'info>,
    /// CHECK: Must equal the owner's pinned validator in the pool account.
    pub validator: UncheckedAccount<'info>,
}

#[vrf]
#[derive(Accounts)]
pub struct RequestErPoolProbe<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut, seeds = [b"er-pool", ADMIN.as_ref(), payer.key().as_ref()], bump = session.session.bump,
        constraint = session.session.authority == ADMIN, constraint = session.session.delegate == payer.key())]
    pub session: Account<'info, ErPoolSession>,
    /// CHECK: Fixed ER queue, never selected by a browser or delegate.
    #[account(mut, address = vrf::consts::DEFAULT_EPHEMERAL_QUEUE, owner = vrf::consts::VRF_PROGRAM_ID)]
    pub oracle_queue: UncheckedAccount<'info>,
}

#[vrf_callback]
#[derive(Accounts)]
pub struct ConsumeErPoolProbe<'info> {
    #[account(mut, seeds = [b"er-pool", ADMIN.as_ref(), session.session.delegate.as_ref()], bump = session.session.bump,
        constraint = session.session.authority == ADMIN)]
    pub session: Account<'info, ErPoolSession>,
}

#[derive(Accounts)]
pub struct ManageErPoolSession<'info> {
    pub payer: Signer<'info>,
    #[account(mut, seeds = [b"er-pool", ADMIN.as_ref(), session.session.delegate.as_ref()], bump = session.session.bump,
        constraint = session.session.authority == ADMIN,
        constraint = payer.key() == ADMIN || session.session.delegate == payer.key())]
    pub session: Account<'info, ErPoolSession>,
}

#[commit]
#[derive(Accounts)]
pub struct UndelegateErPoolSession<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut, seeds = [b"er-pool", ADMIN.as_ref(), payer.key().as_ref()], bump = session.session.bump,
        constraint = session.session.authority == ADMIN, constraint = session.session.delegate == payer.key())]
    pub session: Account<'info, ErPoolSession>,
}

#[derive(Accounts)]
pub struct UpdateErPoolPolicy<'info> {
    #[account(address = ADMIN)]
    pub admin: Signer<'info>,
    #[account(mut, seeds = [b"er-pool", ADMIN.as_ref(), session.session.delegate.as_ref()], bump = session.session.bump,
        constraint = session.session.authority == ADMIN)]
    pub session: Account<'info, ErPoolSession>,
}

// Separate discriminator/PDA: legacy request/renew instructions cannot bypass
// policy checks or overwrite an account created for the pool.
#[account]
pub struct ErPoolSession {
    pub session: ErSession,
    pub authorized_until: i64,
    pub batch_requests: u16,
    pub grant_seconds: i64,
    pub daily_limit: u32,
    pub total_limit: u32,
    pub used_today: u32,
    pub used_total: u32,
    pub day: i64,
    pub paused: bool,
    pub renewals: u32,
}
impl ErPoolSession {
    pub const SPACE: usize = ErSession::SPACE + 8 + 2 + 8 + 4 * 4 + 8 + 1 + 4;
    pub fn new(delegate: Pubkey, validator: Pubkey, authorized_until: i64, batch_requests: u16,
        grant_seconds: i64, daily_limit: u32, total_limit: u32, now: i64, bump: u8) -> Result<Self> {
        let session = ErSession::new(delegate, validator, now + 1, 1, now, bump)?;
        let mut state = Self { session, authorized_until: 0, batch_requests: 0, grant_seconds: 0,
            daily_limit: 0, total_limit: 0, used_today: 0, used_total: 0, day: now.div_euclid(86_400), paused: true, renewals: 0 };
        state.update_policy(authorized_until, batch_requests, grant_seconds, daily_limit, total_limit, now)?;
        Ok(state)
    }
    pub fn update_policy(&mut self, authorized_until: i64, batch_requests: u16, grant_seconds: i64,
        daily_limit: u32, total_limit: u32, now: i64) -> Result<()> {
        require!(now >= 0 && authorized_until > now && authorized_until <= now.checked_add(MAX_POOL_POLICY_LIFETIME)
            .ok_or(ProbeError::InvalidPoolPolicy)?, ProbeError::InvalidPoolPolicy);
        require!(batch_requests > 0 && batch_requests <= MAX_SPONSORED_REQUESTS
            && grant_seconds > 0 && grant_seconds <= MAX_SPONSOR_LIFETIME
            && daily_limit > 0 && daily_limit <= MAX_POOL_DAILY_REQUESTS
            && total_limit > self.used_total && total_limit <= MAX_POOL_TOTAL_REQUESTS, ProbeError::InvalidPoolPolicy);
        let day = now.div_euclid(86_400);
        require!(day >= self.day, ProbeError::InvalidPoolPolicy);
        let today = if day == self.day { self.used_today } else { 0 };
        require!(daily_limit >= today, ProbeError::InvalidPoolPolicy);
        self.authorized_until = authorized_until; self.batch_requests = batch_requests; self.grant_seconds = grant_seconds;
        self.daily_limit = daily_limit; self.total_limit = total_limit; self.paused = false;
        self.day = day; self.used_today = today;
        self.session.remaining = 0; self.session.expires_at = now;
        Ok(())
    }
    pub fn start(&mut self, delegate: Pubkey, nonce: u64, count: u16, target: u16, threshold: u64, now: i64, slot: u64) -> Result<()> {
        validate_request(count, target, threshold)?;
        require!(self.session.authority == ADMIN && self.session.delegate == delegate, ProbeError::InvalidSponsor);
        require!(!self.paused && now < self.authorized_until, ProbeError::PoolPolicyInactive);
        require!(!self.session.has_attempt || self.session.attempt.status == FULFILLED, ProbeError::ErAttemptPending);
        require!(nonce == self.session.next_nonce && nonce < u64::MAX, ProbeError::WrongNonce);
        let day = now.div_euclid(86_400);
        require!(now >= 0 && day >= self.day, ProbeError::InvalidPoolPolicy);
        let today = if day == self.day { self.used_today } else { 0 };
        require!(today < self.daily_limit && self.used_total < self.total_limit, ProbeError::PoolBudgetExhausted);
        if self.session.remaining == 0 || now >= self.session.expires_at {
            self.session.remaining = u32::from(self.batch_requests).min(self.daily_limit - today)
                .min(self.total_limit - self.used_total) as u16;
            self.session.expires_at = (now + self.grant_seconds).min(self.authorized_until).min((day + 1) * 86_400);
            self.renewals = self.renewals.checked_add(1).ok_or(ProbeError::InvalidPoolPolicy)?;
        }
        self.session.start(delegate, nonce, count, target, threshold, now, slot)?;
        self.day = day; self.used_today = today + 1; self.used_total += 1;
        Ok(())
    }
}

#[derive(Accounts)]
#[instruction(delegate: Pubkey)]
pub struct InitializeErSession<'info> {
    #[account(mut, address = ADMIN)]
    pub admin: Signer<'info>,
    #[account(init, payer = admin, space = 8 + ErSession::SPACE,
        seeds = [b"er-session", ADMIN.as_ref(), delegate.as_ref()], bump)]
    pub session: Account<'info, ErSession>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct RenewErSession<'info> {
    #[account(address = ADMIN)]
    pub admin: Signer<'info>,
    #[account(mut, seeds = [b"er-session", ADMIN.as_ref(), session.delegate.as_ref()], bump = session.bump,
        constraint = session.authority == ADMIN)]
    pub session: Account<'info, ErSession>,
}

#[delegate]
#[derive(Accounts)]
#[instruction(delegate: Pubkey)]
pub struct DelegateErSession<'info> {
    #[account(mut, address = ADMIN)]
    pub admin: Signer<'info>,
    /// CHECK: PDA and serialized authority/delegate/validator checked before delegation.
    #[account(mut, del, seeds = [b"er-session", ADMIN.as_ref(), delegate.as_ref()], bump)]
    pub session: UncheckedAccount<'info>,
    /// CHECK: Must equal the validator authorized in the session by ADMIN.
    pub validator: UncheckedAccount<'info>,
}

#[vrf]
#[derive(Accounts)]
pub struct RequestErProbe<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut, seeds = [b"er-session", ADMIN.as_ref(), payer.key().as_ref()], bump = session.bump,
        constraint = session.authority == ADMIN, constraint = session.delegate == payer.key())]
    pub session: Account<'info, ErSession>,
    /// CHECK: Fixed ER queue; the base-layer delegated copy cannot be used here.
    #[account(mut, address = vrf::consts::DEFAULT_EPHEMERAL_QUEUE, owner = vrf::consts::VRF_PROGRAM_ID)]
    pub oracle_queue: UncheckedAccount<'info>,
}

#[vrf_callback]
#[derive(Accounts)]
pub struct ConsumeErProbe<'info> {
    #[account(mut, seeds = [b"er-session", ADMIN.as_ref(), session.delegate.as_ref()], bump = session.bump,
        constraint = session.authority == ADMIN)]
    pub session: Account<'info, ErSession>,
}

#[commit]
#[derive(Accounts)]
pub struct UndelegateErSession<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut, seeds = [b"er-session", ADMIN.as_ref(), payer.key().as_ref()], bump = session.bump,
        constraint = session.authority == ADMIN, constraint = session.delegate == payer.key())]
    pub session: Account<'info, ErSession>,
}

#[account]
pub struct ErSession {
    pub authority: Pubkey,
    pub delegate: Pubkey,
    pub validator: Pubkey,
    pub expires_at: i64,
    pub remaining: u16,
    pub next_nonce: u64,
    pub has_attempt: bool,
    pub bump: u8,
    pub attempt: Attempt,
}
impl ErSession {
    pub const SPACE: usize = 32 + 32 + 32 + 8 + 2 + 8 + 1 + 1 + Attempt::SPACE;
    pub fn new(delegate: Pubkey, validator: Pubkey, expires_at: i64, requests: u16, now: i64, bump: u8) -> Result<Self> {
        let mut permit = SponsorSession { authority: ADMIN, delegate, expires_at: 0, remaining: 0, bump };
        permit.authorize(delegate, expires_at, requests, now)?;
        require!(validator != Pubkey::default(), ProbeError::InvalidErValidator);
        Ok(Self { authority: ADMIN, delegate, validator, expires_at, remaining: requests, next_nonce: 0, has_attempt: false, bump,
            attempt: Attempt { authority: delegate, nonce: 0, box_count: 64, target_index: 0, threshold: 0,
                requested_slot: 0, fulfilled_slot: 0, randomness: [0; 32], roll: 0, sampled_box: 0, success: false, status: FULFILLED, bump } })
    }
    pub fn start(&mut self, delegate: Pubkey, nonce: u64, count: u16, target: u16, threshold: u64, now: i64, slot: u64) -> Result<()> {
        validate_request(count, target, threshold)?;
        require!(self.authority == ADMIN && self.delegate == delegate, ProbeError::InvalidSponsor);
        require!(now < self.expires_at, ProbeError::SponsorExpired);
        require!(self.remaining > 0, ProbeError::SponsorExhausted);
        require!(!self.has_attempt || self.attempt.status == FULFILLED, ProbeError::ErAttemptPending);
        require!(nonce == self.next_nonce, ProbeError::WrongNonce);
        let next = nonce.checked_add(1).ok_or(ProbeError::WrongNonce)?;
        self.attempt = Attempt { authority: delegate, nonce, box_count: count, target_index: target, threshold,
            requested_slot: slot, fulfilled_slot: 0, randomness: [0; 32], roll: 0, sampled_box: 0, success: false, status: PENDING, bump: self.bump };
        self.has_attempt = true; self.next_nonce = next; self.remaining -= 1;
        Ok(())
    }
}

#[derive(Accounts)]
#[instruction(delegate: Pubkey)]
pub struct GrantSponsor<'info> {
    #[account(mut, address = ADMIN)]
    pub admin: Signer<'info>,
    #[account(init, payer = admin, space = 8 + SponsorSession::SPACE,
        seeds = [b"sponsor", ADMIN.as_ref(), delegate.as_ref()], bump)]
    pub sponsor: Account<'info, SponsorSession>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct RevokeSponsor<'info> {
    #[account(address = ADMIN)]
    pub admin: Signer<'info>,
    #[account(mut, seeds = [b"sponsor", ADMIN.as_ref(), sponsor.delegate.as_ref()], bump = sponsor.bump,
        constraint = sponsor.authority == ADMIN)]
    pub sponsor: Account<'info, SponsorSession>,
}

#[vrf]
#[derive(Accounts)]
#[instruction(nonce: u64)]
pub struct RequestSponsoredProbe<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(init, payer = payer, space = 8 + Attempt::SPACE,
        seeds = [b"probe", payer.key().as_ref(), &nonce.to_le_bytes()], bump)]
    pub attempt: Account<'info, Attempt>,
    #[account(mut, seeds = [b"sponsor", ADMIN.as_ref(), payer.key().as_ref()], bump = sponsor.bump,
        constraint = sponsor.authority == ADMIN, constraint = sponsor.delegate == payer.key())]
    pub sponsor: Account<'info, SponsorSession>,
    /// CHECK: Fixed MagicBlock base-layer queue, not selected by the delegate.
    #[account(mut, address = vrf::consts::DEFAULT_QUEUE)]
    pub oracle_queue: UncheckedAccount<'info>,
}

#[account]
pub struct SponsorSession {
    pub authority: Pubkey,
    pub delegate: Pubkey,
    pub expires_at: i64,
    pub remaining: u16,
    pub bump: u8,
}
impl SponsorSession {
    pub const SPACE: usize = 32 + 32 + 8 + 2 + 1;
    pub fn authorize(&mut self, delegate: Pubkey, expires_at: i64, requests: u16, now: i64) -> Result<()> {
        require!(delegate != ADMIN && delegate != Pubkey::default(), ProbeError::InvalidSponsor);
        require!(requests > 0 && requests <= MAX_SPONSORED_REQUESTS, ProbeError::InvalidSponsorQuota);
        require!(expires_at > now && expires_at <= now.checked_add(MAX_SPONSOR_LIFETIME).ok_or(ProbeError::InvalidSponsorExpiry)?, ProbeError::InvalidSponsorExpiry);
        self.delegate = delegate; self.expires_at = expires_at; self.remaining = requests;
        Ok(())
    }
    pub fn consume(&mut self, delegate: Pubkey, now: i64) -> Result<()> {
        require!(self.authority == ADMIN && delegate == self.delegate, ProbeError::InvalidSponsor);
        require!(now < self.expires_at, ProbeError::SponsorExpired);
        require!(self.remaining > 0, ProbeError::SponsorExhausted);
        self.remaining -= 1;
        Ok(())
    }
}

#[vrf]
#[derive(Accounts)]
#[instruction(nonce: u64)]
pub struct RequestProbe<'info> {
    #[account(mut, address = ADMIN)]
    pub payer: Signer<'info>,
    #[account(
        init, payer = payer, space = 8 + Attempt::SPACE,
        seeds = [b"probe", payer.key().as_ref(), &nonce.to_le_bytes()], bump
    )]
    pub attempt: Account<'info, Attempt>,
    /// CHECK: Only MagicBlock's base-layer queue is allowed; never a caller-selected queue.
    #[account(mut, address = vrf::consts::DEFAULT_QUEUE)]
    pub oracle_queue: UncheckedAccount<'info>,
}

#[vrf_callback]
#[derive(Accounts)]
pub struct ConsumeProbe<'info> {
    #[account(
        mut,
        seeds = [b"probe", attempt.authority.as_ref(), &attempt.nonce.to_le_bytes()],
        bump = attempt.bump
    )]
    pub attempt: Account<'info, Attempt>,
}

#[account]
pub struct Attempt {
    pub authority: Pubkey,
    pub nonce: u64,
    pub box_count: u16,
    pub target_index: u16,
    // Number of winning outcomes out of exactly 2^32 possibilities (0 through 2^32).
    pub threshold: u64,
    pub requested_slot: u64,
    pub fulfilled_slot: u64,
    pub randomness: [u8; 32],
    pub roll: u32,
    // Independent diagnostic distribution sample; does NOT select a pickup target.
    pub sampled_box: u16,
    pub success: bool,
    pub status: u8,
    pub bump: u8,
}

impl Attempt {
    pub const SPACE: usize = 32 + 8 + 2 + 2 + 8 + 8 + 8 + 32 + 4 + 2 + 1 + 1 + 1;

    pub fn settle(&mut self, randomness: [u8; 32], nonce: u64, slot: u64) -> Result<()> {
        require!(self.status == PENDING, ProbeError::AlreadyFulfilled);
        require!(nonce == self.nonce, ProbeError::WrongNonce);
        require!(slot >= self.requested_slot, ProbeError::WrongSlot);
        validate_request(self.box_count, self.target_index, self.threshold)?;
        let roll = u32::from_le_bytes(randomness[0..4].try_into().unwrap());
        let sample = u32::from_le_bytes(randomness[4..8].try_into().unwrap());
        // 64 and 128 divide 2^32 exactly, so modulo introduces no sampling bias.
        self.sampled_box = (sample % u32::from(self.box_count)) as u16;
        self.roll = roll;
        self.success = u64::from(roll) < self.threshold;
        self.randomness = randomness;
        self.fulfilled_slot = slot;
        self.status = FULFILLED;
        Ok(())
    }
}

fn validate_request(count: u16, target: u16, threshold: u64) -> Result<()> {
    require!(count == 64 || count == 128, ProbeError::InvalidBoxCount);
    require!(target < count, ProbeError::InvalidTarget);
    require!(threshold <= ROLL_DOMAIN, ProbeError::InvalidThreshold);
    Ok(())
}

#[error_code]
pub enum ProbeError {
    #[msg("Only 64 or 128 boxes are supported by this diagnostic")]
    InvalidBoxCount,
    #[msg("The selected target is outside the inventory")]
    InvalidTarget,
    #[msg("Probability threshold must lie between 0 and 2^32")]
    InvalidThreshold,
    #[msg("This attempt has already consumed randomness")]
    AlreadyFulfilled,
    #[msg("Callback nonce does not match the locked attempt")]
    WrongNonce,
    #[msg("Fulfillment slot cannot precede the request")]
    WrongSlot,
    #[msg("Invalid sponsor authority or delegate")]
    InvalidSponsor,
    #[msg("Sponsor request quota must be between 1 and 500")]
    InvalidSponsorQuota,
    #[msg("Sponsor must expire within the next 24 hours")]
    InvalidSponsorExpiry,
    #[msg("Sponsor authorization has expired")]
    SponsorExpired,
    #[msg("Sponsor authorization has no requests remaining")]
    SponsorExhausted,
    #[msg("The previous ER attempt must finish before reuse or undelegation")]
    ErAttemptPending,
    #[msg("ER validator must match the administrator's authorized validator")]
    InvalidErValidator,
    #[msg("Invalid bounded pool policy")]
    InvalidPoolPolicy,
    #[msg("Pool policy paused or expired")]
    PoolPolicyInactive,
    #[msg("Pool daily or lifetime request limit reached")]
    PoolBudgetExhausted,
    #[msg("Pause the pool policy before returning the account")]
    PoolPolicyMustPause,
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn pool_renews_atomically_and_enforces_daily_lifetime_and_pause_limits() {
        let delegate = Pubkey::new_unique();
        let mut state = ErPoolSession::new(delegate, Pubkey::new_unique(), 200_000, 2, 100, 3, 5, 100, 253).unwrap();
        for nonce in 0..3u64 {
            state.start(delegate, nonce, 64, 4, ROLL_DOMAIN / 2, 110, 1000 + nonce * 2).unwrap();
            assert!(state.start(delegate, nonce + 1, 64, 4, 0, 110, 1001 + nonce * 2).is_err());
            state.session.attempt.settle(bytes(0, 1), nonce, 1001 + nonce * 2).unwrap();
        }
        assert_eq!(state.renewals, 2);
        assert_eq!(state.used_total, 3);
        assert!(state.start(delegate, 3, 64, 4, 0, 111, 1010).is_err());
        assert!(state.start(Pubkey::new_unique(), 3, 64, 4, 0, 86_410, 1010).is_err());
        state.start(delegate, 3, 64, 4, 0, 86_410, 1010).unwrap();
        state.session.attempt.settle(bytes(0, 1), 3, 1011).unwrap();
        assert_eq!(state.used_today, 1);
        assert_eq!(state.used_total, 4);
        state.paused = true;
        assert!(state.start(delegate, 4, 64, 4, 0, 86_411, 1012).is_err());
        state.update_policy(200_000, 2, 100, 3, 5, 86_411).unwrap();
        assert_eq!(state.session.next_nonce, 4);
        assert_eq!(state.used_total, 4);
        state.start(delegate, 4, 64, 4, ROLL_DOMAIN, 86_412, 1012).unwrap();
        state.session.attempt.settle(bytes(u32::MAX, 0), 4, 1013).unwrap();
        assert!(state.session.attempt.success);
        assert!(state.start(delegate, 5, 64, 4, 0, 172_810, 1014).is_err());
        assert!(state.update_policy(200_000, 2, 100, 3, 5, 86_413).is_err());
        let mut data = Vec::new(); state.try_serialize(&mut data).unwrap();
        assert_eq!(data.len(), 280); assert_eq!(data.len(), 8 + ErPoolSession::SPACE);
        assert!(ErSession::try_deserialize(&mut &data[..]).is_err(), "Legacy instructions cannot consume pool accounts");
    }
    #[test]
    fn pool_expiry_cannot_replace_pending_draw_and_late_callback_still_settles() {
        let delegate = Pubkey::new_unique();
        let mut state = ErPoolSession::new(delegate, Pubkey::new_unique(), 1000, 2, 10, 500, 1000, 100, 253).unwrap();
        state.start(delegate, 0, 64, 4, 0, 110, 1000).unwrap();
        state.session.attempt.settle(bytes(0, 0), 0, 1001).unwrap();
        state.start(delegate, 1, 64, 4, 0, 121, 1002).unwrap();
        assert_eq!(state.renewals, 2);
        assert!(state.start(delegate, 2, 64, 4, 0, 200, 1003).is_err());
        assert_eq!(state.renewals, 2); assert_eq!(state.used_total, 2);
        state.paused = true;
        state.session.attempt.settle(bytes(0, 0), 1, 2000).unwrap();
        assert!(state.start(delegate, 2, 64, 4, 0, 200, 2001).is_err());
        state.paused = false;
        assert!(state.start(delegate, 2, 64, 4, 0, 1000, 2001).is_err());
        assert_eq!(state.used_total, 2);
        for (batch, seconds, daily, total) in [(0, 10, 500, 1000), (501, 10, 500, 1000),
            (2, 0, 500, 1000), (2, 86_401, 500, 1000), (2, 10, 0, 1000),
            (2, 10, 10_001, 1000), (2, 10, 500, 70_001)] {
            assert!(ErPoolSession::new(delegate, Pubkey::new_unique(), 1000, batch, seconds, daily, total, 100, 253).is_err());
        }
    }
    fn pending(count: u16, threshold: u64) -> Attempt {
        Attempt {
            authority: ADMIN, nonce: 7, box_count: count, target_index: count - 1,
            threshold, requested_slot: 100, fulfilled_slot: 0, randomness: [0; 32],
            roll: 0, sampled_box: 0, success: false, status: PENDING, bump: 255,
        }
    }
    fn bytes(roll: u32, sample: u32) -> [u8; 32] {
        let mut b = [0; 32];
        b[..4].copy_from_slice(&roll.to_le_bytes());
        b[4..8].copy_from_slice(&sample.to_le_bytes());
        b
    }
    #[test]
    fn er_session_preserves_odds_and_forbids_replay_or_pending_overwrite() {
        let delegate = Pubkey::new_unique();
        let mut s = ErSession::new(delegate, Pubkey::new_unique(), 200, 2, 100, 254).unwrap();
        assert!(s.start(Pubkey::new_unique(), 0, 64, 4, ROLL_DOMAIN, 110, 1000).is_err());
        assert!(s.start(delegate, 1, 64, 4, ROLL_DOMAIN, 110, 1000).is_err());
        assert!(s.start(delegate, 0, 65, 4, ROLL_DOMAIN, 110, 1000).is_err());
        assert_eq!(s.remaining, 2);
        s.start(delegate, 0, 64, 4, ROLL_DOMAIN, 110, 1000).unwrap();
        assert!(s.start(delegate, 1, 64, 4, ROLL_DOMAIN, 111, 1001).is_err());
        assert!(s.attempt.settle(bytes(0, 1), 1, 1001).is_err());
        s.attempt.settle(bytes(u32::MAX, 1), 0, 1001).unwrap(); assert!(s.attempt.success);
        assert!(s.attempt.settle(bytes(0, 1), 0, 1002).is_err());
        assert!(s.start(delegate, 0, 64, 4, 0, 112, 1002).is_err());
        s.start(delegate, 1, 64, 4, 0, 112, 1002).unwrap();
        s.attempt.settle(bytes(0, 1), 1, 1003).unwrap(); assert!(!s.attempt.success);
        assert!(s.start(delegate, 2, 64, 4, 0, 113, 1004).is_err());
        let mut data = Vec::new(); s.try_serialize(&mut data).unwrap();
        assert_eq!(data.len(), 233); assert_eq!(data.len(), 8 + ErSession::SPACE);
        let mut late = ErSession::new(delegate, Pubkey::new_unique(), 200, 1, 100, 254).unwrap();
        late.start(delegate, 0, 128, 9, ROLL_DOMAIN / 2, 199, 1000).unwrap();
        late.attempt.settle(bytes(0, 2), 0, 2000).unwrap(); assert!(late.attempt.success);
    }
    #[test]
    fn er_session_allows_500_requests_and_rejects_the_501st() {
        let delegate = Pubkey::new_unique();
        assert!(ErSession::new(delegate, Pubkey::new_unique(), 200, 501, 100, 254).is_err());
        let mut s = ErSession::new(delegate, Pubkey::new_unique(), 200, 500, 100, 254).unwrap();
        for nonce in 0..500u64 {
            s.start(delegate, nonce, 64, 4, ROLL_DOMAIN / 2, 110, 1000 + nonce * 2).unwrap();
            assert!(s.start(delegate, nonce + 1, 64, 4, 0, 110, 1001 + nonce * 2).is_err());
            s.attempt.settle(bytes(0, 1), nonce, 1001 + nonce * 2).unwrap();
            assert_eq!(s.remaining, 499 - nonce as u16);
            assert_eq!(s.next_nonce, nonce + 1);
        }
        assert!(s.start(delegate, 500, 64, 4, 0, 110, 2000).is_err());
        assert_eq!(s.remaining, 0);
        assert_eq!(s.next_nonce, 500);
        let mut data = Vec::new(); s.try_serialize(&mut data).unwrap();
        assert_eq!(data.len(), 233);
    }
    #[test]
    fn exact_probability_boundaries_and_one_roll() {
        for count in [64, 128] {
            let mut zero = pending(count, 0);
            zero.settle(bytes(0, 0), 7, 101).unwrap();
            assert!(!zero.success);
            let mut one = pending(count, ROLL_DOMAIN);
            one.settle(bytes(u32::MAX, u32::MAX), 7, 101).unwrap();
            assert!(one.success);
            assert_eq!(one.sampled_box, count - 1);
            let mut half = pending(count, ROLL_DOMAIN / 2);
            half.settle(bytes(1 << 31, 19), 7, 101).unwrap();
            assert!(!half.success);
            assert!(half.settle(bytes(0, 0), 7, 102).is_err());
            assert_eq!(half.roll, 1 << 31);
            assert!(!half.success);
        }
    }
    #[test]
    fn invalid_requests_and_stale_callbacks_cannot_change_state() {
        for count in [0, 63, 65, 127, 129, u16::MAX] {
            assert!(validate_request(count, 0, 1).is_err());
        }
        assert!(validate_request(64, 64, 1).is_err());
        assert!(validate_request(128, 0, ROLL_DOMAIN + 1).is_err());
        let mut a = pending(64, 1);
        assert!(a.settle([0; 32], 8, 101).is_err());
        assert!(a.settle([0; 32], 7, 99).is_err());
        assert_eq!(a.status, PENDING);
        a.settle([0; 32], 7, 101).unwrap();
        assert!(a.success);
    }
    #[test]
    fn serialized_size_matches_allocation() {
        let mut data = Vec::new();
        pending(64, 1).try_serialize(&mut data).unwrap();
        assert_eq!(data.len(), 8 + Attempt::SPACE);
    }
    #[test]
    fn sponsorship_is_bounded_and_cannot_change_upgrade_authority() {
        let delegate = Pubkey::new_unique();
        let mut s = SponsorSession { authority: ADMIN, delegate, expires_at: 0, remaining: 0, bump: 1 };
        for quota in [0, MAX_SPONSORED_REQUESTS + 1] { assert!(s.authorize(delegate, 200, quota, 100).is_err()); }
        for expiry in [99, 100, 100 + MAX_SPONSOR_LIFETIME + 1] { assert!(s.authorize(delegate, expiry, 2, 100).is_err()); }
        assert!(s.authorize(ADMIN, 200, 2, 100).is_err());
        assert!(s.authorize(Pubkey::default(), 200, 2, 100).is_err());
        s.authorize(delegate, 200, 2, 100).unwrap();
        assert!(s.consume(Pubkey::new_unique(), 150).is_err()); assert_eq!(s.remaining, 2);
        assert!(s.consume(delegate, 200).is_err()); assert_eq!(s.remaining, 2);
        s.consume(delegate, 150).unwrap(); s.consume(delegate, 199).unwrap();
        assert!(s.consume(delegate, 199).is_err());
        assert_eq!(s.authority, ADMIN);
        let mut data = Vec::new(); s.try_serialize(&mut data).unwrap(); assert_eq!(data.len(), 8 + SponsorSession::SPACE);
        // An authentic late callback still settles after the sponsor has expired;
        // expiry blocks new requests, never changes an already locked outcome.
        let mut a = pending(64, ROLL_DOMAIN); a.authority = delegate;
        a.settle(bytes(u32::MAX, 1), 7, 1000).unwrap(); assert!(a.success);
    }
}
