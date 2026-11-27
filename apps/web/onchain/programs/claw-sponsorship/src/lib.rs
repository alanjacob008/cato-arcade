use anchor_lang::prelude::*;

declare_id!("5sWQhWwQrxwuhK2z82g6rupt5ixxPsyrxdUFtSSUwbE8");
pub const SEED: &[u8] = b"claw-sponsor-v1";
pub const LANES: usize = 4;
pub const MAX_POLICY_SECONDS: i64 = 30 * 86400;
pub const MAX_DAILY_LAMPORTS: u64 = 1_000_000_000;

#[program]
pub mod claw_sponsorship {
    use super::*;
    pub fn initialize(ctx: Context<Initialize>, keeper: Pubkey, recipients: [Pubkey; LANES], policy: Policy) -> Result<()> {
        require!(cfg!(feature = "devnet"), SponsorError::DevnetOnly);
        let owner = ctx.accounts.owner.key();
        require!(keeper != Pubkey::default() && keeper != owner, SponsorError::InvalidKeeper);
        for (i, recipient) in recipients.iter().enumerate() {
            require!(*recipient != Pubkey::default() && *recipient != owner && *recipient != keeper
                && *recipient != ctx.accounts.vault.key() && !recipients[..i].contains(recipient), SponsorError::InvalidRecipient);
        }
        let now = Clock::get()?.unix_timestamp;
        policy.validate(now, 0, 0)?;
        *ctx.accounts.vault = SponsorshipVault { owner, keeper, recipients, policy, bump: ctx.bumps.vault,
            paused: false, day: now.div_euclid(86400), spent_today: 0, spent_total: 0,
            nonces: [0; LANES], last_topups: [0; LANES] };
        Ok(())
    }
    pub fn configure(ctx: Context<OwnerControl>, keeper: Pubkey, policy: Policy) -> Result<()> {
        require!(cfg!(feature = "devnet"), SponsorError::DevnetOnly);
        let v = &mut ctx.accounts.vault;
        require!(keeper != Pubkey::default() && keeper != v.owner && !v.recipients.contains(&keeper), SponsorError::InvalidKeeper);
        let now = Clock::get()?.unix_timestamp;
        let day = now.div_euclid(86400);
        require!(day >= v.day, SponsorError::ClockWentBackwards);
        policy.validate(now, if day > v.day { 0 } else { v.spent_today }, v.spent_total)?;
        if day > v.day { v.day = day; v.spent_today = 0; }
        v.keeper = keeper; v.policy = policy; // Counters, recipients and nonces never reset.
        Ok(())
    }
    pub fn set_paused(ctx: Context<OwnerControl>, paused: bool) -> Result<()> {
        require!(cfg!(feature = "devnet"), SponsorError::DevnetOnly);
        ctx.accounts.vault.paused = paused; Ok(())
    }
    pub fn withdraw(ctx: Context<OwnerControl>, lamports: u64) -> Result<()> {
        require!(cfg!(feature = "devnet"), SponsorError::DevnetOnly);
        require!(ctx.accounts.vault.paused && lamports > 0, SponsorError::PauseFirst);
        let vault = ctx.accounts.vault.to_account_info();
        let floor = Rent::get()?.minimum_balance(vault.data_len());
        require!(vault.lamports().saturating_sub(floor) >= lamports, SponsorError::InsufficientVault);
        move_lamports(&vault, &ctx.accounts.owner.to_account_info(), lamports)
    }
    pub fn top_up(ctx: Context<TopUp>, index: u8, nonce: u64) -> Result<()> {
        require!(cfg!(feature = "devnet"), SponsorError::DevnetOnly);
        let i = usize::from(index);
        require!(i < LANES, SponsorError::InvalidRecipient);
        let recipient = ctx.accounts.recipient.to_account_info();
        require!(ctx.accounts.vault.recipients[i] == recipient.key() && !recipient.executable, SponsorError::InvalidRecipient);
        let vault = ctx.accounts.vault.to_account_info();
        let floor = Rent::get()?.minimum_balance(vault.data_len())
            .checked_add(ctx.accounts.vault.policy.reserve_lamports).ok_or(SponsorError::Overflow)?;
        let now = Clock::get()?.unix_timestamp;
        let amount = ctx.accounts.vault.reserve_topup(i, nonce, recipient.lamports(), vault.lamports().saturating_sub(floor), now)?;
        move_lamports(&vault, &recipient, amount)?;
        emit!(TopupReceipt { vault: vault.key(), recipient: recipient.key(), index, nonce, lamports: amount });
        Ok(())
    }
}

fn move_lamports(from: &AccountInfo, to: &AccountInfo, amount: u64) -> Result<()> {
    let remaining = from.lamports().checked_sub(amount).ok_or(SponsorError::InsufficientVault)?;
    let total = to.lamports().checked_add(amount).ok_or(SponsorError::Overflow)?;
    **from.try_borrow_mut_lamports()? = remaining;
    **to.try_borrow_mut_lamports()? = total;
    Ok(())
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug)]
pub struct Policy {
    pub low_lamports: u64,
    pub target_lamports: u64,
    pub daily_limit: u64,
    pub total_limit: u64,
    pub reserve_lamports: u64,
    pub cooldown_seconds: i64,
    pub authorized_until: i64,
}
impl Policy {
    pub const SPACE: usize = 7 * 8;
    fn validate(&self, now: i64, today: u64, total: u64) -> Result<()> {
        require!(self.low_lamports > 0 && self.low_lamports < self.target_lamports
            && self.target_lamports <= self.daily_limit && self.daily_limit <= MAX_DAILY_LAMPORTS
            && self.daily_limit >= today && self.total_limit >= self.daily_limit && self.total_limit >= total
            && self.total_limit <= 30 * MAX_DAILY_LAMPORTS
            && self.cooldown_seconds >= 60 && self.cooldown_seconds <= 86400
            && self.authorized_until > now && self.authorized_until <= now.checked_add(MAX_POLICY_SECONDS).ok_or(SponsorError::Overflow)?,
            SponsorError::InvalidPolicy); Ok(())
    }
}

#[account]
pub struct SponsorshipVault {
    pub owner: Pubkey,
    pub keeper: Pubkey,
    pub recipients: [Pubkey; LANES],
    pub policy: Policy,
    pub bump: u8,
    pub paused: bool,
    pub day: i64,
    pub spent_today: u64,
    pub spent_total: u64,
    pub nonces: [u64; LANES],
    pub last_topups: [i64; LANES],
}
impl SponsorshipVault {
    pub const SPACE: usize = 32 * 6 + Policy::SPACE + 2 + 8 * 3 + 8 * LANES * 2;
    fn reserve_topup(&mut self, i: usize, nonce: u64, balance: u64, available: u64, now: i64) -> Result<u64> {
        require!(i < LANES, SponsorError::InvalidRecipient);
        require!(!self.paused && now < self.policy.authorized_until, SponsorError::Disabled);
        require!(nonce == self.nonces[i], SponsorError::StaleNonce);
        require!(balance < self.policy.low_lamports, SponsorError::AlreadyFunded);
        let day = now.div_euclid(86400);
        require!(day >= self.day && now >= self.last_topups[i], SponsorError::ClockWentBackwards);
        require!(self.last_topups[i] == 0 || now - self.last_topups[i] >= self.policy.cooldown_seconds, SponsorError::Cooldown);
        let amount = self.policy.target_lamports.checked_sub(balance).ok_or(SponsorError::Overflow)?;
        require!(amount <= available, SponsorError::InsufficientVault);
        let today = (if day > self.day { 0 } else { self.spent_today }).checked_add(amount).ok_or(SponsorError::Overflow)?;
        let total = self.spent_total.checked_add(amount).ok_or(SponsorError::Overflow)?;
        require!(today <= self.policy.daily_limit && total <= self.policy.total_limit, SponsorError::BudgetExhausted);
        self.nonces[i] = nonce.checked_add(1).ok_or(SponsorError::Overflow)?;
        self.last_topups[i] = now; self.day = day; self.spent_today = today; self.spent_total = total;
        Ok(amount)
    }
}
#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)] pub owner: Signer<'info>,
    #[account(init, payer = owner, space = 8 + SponsorshipVault::SPACE, seeds = [SEED, owner.key().as_ref()], bump)]
    pub vault: Account<'info, SponsorshipVault>,
    pub system_program: Program<'info, System>,
}
#[derive(Accounts)]
pub struct OwnerControl<'info> {
    #[account(mut)] pub owner: Signer<'info>,
    #[account(mut, seeds = [SEED, owner.key().as_ref()], bump = vault.bump, has_one = owner)]
    pub vault: Account<'info, SponsorshipVault>,
}
#[derive(Accounts)]
pub struct TopUp<'info> {
    pub keeper: Signer<'info>,
    #[account(mut, seeds = [SEED, vault.owner.as_ref()], bump = vault.bump, has_one = keeper)]
    pub vault: Account<'info, SponsorshipVault>,
    #[account(mut)] pub recipient: SystemAccount<'info>,
}
#[event]
pub struct TopupReceipt { pub vault: Pubkey, pub recipient: Pubkey, pub index: u8, pub nonce: u64, pub lamports: u64 }
#[error_code]
pub enum SponsorError {
    #[msg("Devnet build required")] DevnetOnly,
    #[msg("Invalid keeper")] InvalidKeeper,
    #[msg("Recipient is not an approved system wallet")] InvalidRecipient,
    #[msg("Invalid bounded funding policy")] InvalidPolicy,
    #[msg("Vault is paused or authorization expired")] Disabled,
    #[msg("Pause the vault before owner withdrawal")] PauseFirst,
    #[msg("Old or duplicate refill nonce")] StaleNonce,
    #[msg("Recipient already has sufficient funds")] AlreadyFunded,
    #[msg("Refill cooldown active")] Cooldown,
    #[msg("Funding budget exhausted")] BudgetExhausted,
    #[msg("Vault reserve or rent would be depleted")] InsufficientVault,
    #[msg("Clock went backwards")] ClockWentBackwards,
    #[msg("Arithmetic overflow")] Overflow,
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> SponsorshipVault {
        let now = 100_000;
        let policy = Policy { low_lamports: 2_000_000, target_lamports: 5_000_000, daily_limit: 10_000_000,
            total_limit: 15_000_000, reserve_lamports: 10_000_000, cooldown_seconds: 60, authorized_until: now + 86400 * 7 };
        policy.validate(now, 0, 0).unwrap();
        SponsorshipVault { owner: Pubkey::new_unique(), keeper: Pubkey::new_unique(), recipients: [Pubkey::new_unique(); LANES],
            policy, bump: 255, paused: false, day: now / 86400, spent_today: 0, spent_total: 0, nonces: [0; LANES], last_topups: [0; LANES] }
    }
    #[test] fn refills_to_target_with_replay_and_cooldown_protection() {
        let mut v = fixture();
        assert_eq!(v.reserve_topup(0, 0, 1_000_000, 100_000_000, 100_000).unwrap(), 4_000_000);
        assert!(v.reserve_topup(0, 0, 0, 100_000_000, 100_061).is_err());
        assert!(v.reserve_topup(0, 1, 0, 100_000_000, 100_001).is_err());
        assert!(v.reserve_topup(0, 1, 2_000_000, 100_000_000, 100_061).is_err());
        assert_eq!(v.reserve_topup(0, 1, 0, 100_000_000, 100_061).unwrap(), 5_000_000);
        assert_eq!(v.nonces[0], 2);
    }
    #[test] fn daily_and_total_caps_survive_day_and_policy_changes() {
        let mut v = fixture();
        v.reserve_topup(0, 0, 0, 100_000_000, 100_000).unwrap();
        v.reserve_topup(1, 0, 0, 100_000_000, 100_000).unwrap();
        assert!(v.reserve_topup(2, 0, 0, 100_000_000, 100_000).is_err());
        v.reserve_topup(2, 0, 0, 100_000_000, 186_400).unwrap();
        assert!(v.reserve_topup(3, 0, 0, 100_000_000, 186_400).is_err());
        assert!(v.policy.validate(186_400, v.spent_today, 16_000_000).is_err());
    }
    #[test] fn rejects_pause_expiry_insufficient_funds_and_bad_index() {
        let mut v = fixture();
        assert!(v.reserve_topup(4, 0, 0, 100_000_000, 100_000).is_err());
        assert!(v.reserve_topup(0, 0, 0, 4_999_999, 100_000).is_err());
        assert!(v.reserve_topup(0, 0, 0, 100_000_000, v.policy.authorized_until).is_err());
        v.paused = true;
        assert!(v.reserve_topup(0, 0, 0, 100_000_000, 100_000).is_err());
    }
}
