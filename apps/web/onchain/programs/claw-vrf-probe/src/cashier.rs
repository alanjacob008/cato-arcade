pub const DEVNET_USDC: Pubkey = pubkey!("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");
pub const CASHIER_TOKEN_PROGRAM: Pubkey = pubkey!("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
pub const CASHIER_ASSOCIATED_PROGRAM: Pubkey = pubkey!("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
pub const CASHIER_SEED: &[u8] = b"cashier-devnet-v1";
pub const UNITS_PER_CENT: u64 = 10_000;

#[account]
pub struct DevnetCashier {
    pub authority: Pubkey,
    pub settlement: Pubkey,
    pub mint: Pubkey,
    pub bump: u8,
    pub paused: bool,
    pub daily_limit: u64,
    pub day: i64,
    pub paid_today: u64,
    pub max_claim: u64,
}
impl DevnetCashier {
    pub const SPACE: usize = 32 * 3 + 2 + 8 * 4;
    pub fn reserve_payout(&mut self, amount: u64, now: i64) -> Result<()> {
        require!(!self.paused, CashierError::Paused);
        require!(amount > 0 && amount % UNITS_PER_CENT == 0 && amount <= self.max_claim, CashierError::InvalidAmount);
        let day = now.div_euclid(86_400);
        require!(day >= self.day, CashierError::InvalidDay);
        let used = if day > self.day { 0 } else { self.paid_today };
        let next = used.checked_add(amount).ok_or(CashierError::InvalidAmount)?;
        require!(next <= self.daily_limit, CashierError::DailyLimit);
        self.day = day; self.paid_today = next;
        Ok(())
    }
}

#[account]
pub struct DevnetDepositReceipt {
    pub buyer: Pubkey,
    pub reference: [u8; 32],
    pub tier: u8,
    pub quantity: u16,
    pub amount: u64,
}
impl DevnetDepositReceipt { pub const SPACE: usize = 32 + 32 + 1 + 2 + 8; }

#[account]
pub struct DevnetWithdrawalReceipt {
    pub wallet: Pubkey,
    pub reference: [u8; 32],
    pub amount: u64,
}
impl DevnetWithdrawalReceipt { pub const SPACE: usize = 32 + 32 + 8; }

#[derive(Accounts)]
pub struct InitializeDevnetCashier<'info> {
    #[account(mut, address = ADMIN)]
    pub admin: Signer<'info>,
    #[account(init, payer = admin, space = 8 + DevnetCashier::SPACE, seeds = [CASHIER_SEED], bump)]
    pub cashier: Account<'info, DevnetCashier>,
    /// CHECK: Pinned original-token-program mint; decimals and initialized flag checked below.
    #[account(address = DEVNET_USDC, owner = CASHIER_TOKEN_PROGRAM)]
    pub mint: UncheckedAccount<'info>,
    /// CHECK: Its canonical ATA address, mint, initialized state and PDA authority are checked below.
    pub vault: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(reference: [u8; 32])]
pub struct DepositDevnetTokens<'info> {
    #[account(mut, address = cashier.settlement)]
    pub sponsor: Signer<'info>,
    pub buyer: Signer<'info>,
    #[account(seeds = [CASHIER_SEED], bump = cashier.bump, has_one = mint)]
    pub cashier: Account<'info, DevnetCashier>,
    #[account(init, payer = sponsor, space = 8 + DevnetDepositReceipt::SPACE,
        seeds = [b"cashier-deposit", cashier.key().as_ref(), buyer.key().as_ref(), reference.as_ref()], bump)]
    pub receipt: Account<'info, DevnetDepositReceipt>,
    /// CHECK: Pinned mint and exact decimals checked in the handler.
    #[account(address = DEVNET_USDC, owner = CASHIER_TOKEN_PROGRAM)]
    pub mint: UncheckedAccount<'info>,
    /// CHECK: Canonical buyer ATA, token mint and authority checked in the handler and token CPI.
    #[account(mut)]
    pub source: UncheckedAccount<'info>,
    /// CHECK: Canonical cashier ATA, token mint and authority checked in the handler and token CPI.
    #[account(mut)]
    pub vault: UncheckedAccount<'info>,
    /// CHECK: Fixed original SPL Token executable; no Token-2022 extensions are accepted.
    #[account(address = CASHIER_TOKEN_PROGRAM, executable)]
    pub token_program: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(reference: [u8; 32])]
pub struct WithdrawDevnetWinnings<'info> {
    #[account(mut, address = cashier.settlement)]
    pub settlement: Signer<'info>,
    #[account(mut, seeds = [CASHIER_SEED], bump = cashier.bump, has_one = mint)]
    pub cashier: Account<'info, DevnetCashier>,
    /// CHECK: Fixed recipient, bound into the immutable receipt. The authenticated ledger authorizes its winnings.
    pub wallet: UncheckedAccount<'info>,
    #[account(init, payer = settlement, space = 8 + DevnetWithdrawalReceipt::SPACE,
        seeds = [b"cashier-claim", cashier.key().as_ref(), reference.as_ref()], bump)]
    pub receipt: Account<'info, DevnetWithdrawalReceipt>,
    /// CHECK: Pinned mint and exact decimals checked in the handler.
    #[account(address = DEVNET_USDC, owner = CASHIER_TOKEN_PROGRAM)]
    pub mint: UncheckedAccount<'info>,
    /// CHECK: Canonical cashier ATA with the expected mint and PDA authority.
    #[account(mut)]
    pub vault: UncheckedAccount<'info>,
    /// CHECK: Canonical recipient ATA with the expected mint and wallet authority.
    #[account(mut)]
    pub destination: UncheckedAccount<'info>,
    /// CHECK: Fixed original SPL Token executable.
    #[account(address = CASHIER_TOKEN_PROGRAM, executable)]
    pub token_program: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct PauseDevnetCashier<'info> {
    #[account(address = ADMIN)]
    pub admin: Signer<'info>,
    #[account(mut, seeds = [CASHIER_SEED], bump = cashier.bump, has_one = authority @ CashierError::InvalidAuthority)]
    pub cashier: Account<'info, DevnetCashier>,
    /// CHECK: Fixed authority; the admin signer must have the same key.
    #[account(address = ADMIN)]
    pub authority: UncheckedAccount<'info>,
}

fn cashier_price(tier: u8, quantity: u16) -> Result<u64> {
    require!(tier < 3 && quantity > 0 && quantity <= 1000, CashierError::InvalidPurchase);
    Ok([2_000_000u64, 4_000_000, 6_000_000][tier as usize] * u64::from(quantity))
}
fn cashier_mint(mint: &AccountInfo) -> Result<()> {
    require_keys_eq!(*mint.key, DEVNET_USDC, CashierError::InvalidMint);
    require_keys_eq!(*mint.owner, CASHIER_TOKEN_PROGRAM, CashierError::InvalidMint);
    let data = mint.try_borrow_data()?;
    require!(data.len() == 82 && data[44] == 6 && data[45] == 1, CashierError::InvalidMint);
    Ok(())
}
fn cashier_ata(owner: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[owner.as_ref(), CASHIER_TOKEN_PROGRAM.as_ref(), DEVNET_USDC.as_ref()], &CASHIER_ASSOCIATED_PROGRAM).0
}
fn cashier_token(account: &AccountInfo, owner: &Pubkey) -> Result<()> {
    require_keys_eq!(*account.key, cashier_ata(owner), CashierError::InvalidTokenAccount);
    require_keys_eq!(*account.owner, CASHIER_TOKEN_PROGRAM, CashierError::InvalidTokenAccount);
    let data = account.try_borrow_data()?;
    require!(data.len() == 165 && data[0..32] == DEVNET_USDC.to_bytes()
        && data[32..64] == owner.to_bytes() && data[108] == 1, CashierError::InvalidTokenAccount);
    Ok(())
}
fn cashier_transfer<'info>(from: AccountInfo<'info>, mint: AccountInfo<'info>, to: AccountInfo<'info>,
    authority: AccountInfo<'info>, token: AccountInfo<'info>, amount: u64, seeds: &[&[&[u8]]]) -> Result<()> {
    use anchor_lang::solana_program::{instruction::{AccountMeta, Instruction}, program::invoke_signed};
    let mut data = vec![12u8]; // SPL Token TransferChecked
    data.extend_from_slice(&amount.to_le_bytes()); data.push(6);
    let ix = Instruction { program_id: CASHIER_TOKEN_PROGRAM, accounts: vec![
        AccountMeta::new(*from.key, false), AccountMeta::new_readonly(*mint.key, false),
        AccountMeta::new(*to.key, false), AccountMeta::new_readonly(*authority.key, true)], data };
    invoke_signed(&ix, &[from, mint, to, authority, token], seeds)?;
    Ok(())
}
fn cashier_initialize(ctx: Context<InitializeDevnetCashier>, settlement: Pubkey, daily_limit: u64, max_claim: u64) -> Result<()> {
    require!(cfg!(feature = "devnet"), CashierError::DevnetOnly);
    require!(settlement != Pubkey::default() && settlement != ADMIN, CashierError::InvalidAuthority);
    require!(max_claim > 0 && max_claim % UNITS_PER_CENT == 0 && daily_limit >= max_claim
        && daily_limit <= 100_000_000_000, CashierError::InvalidAmount);
    cashier_mint(&ctx.accounts.mint)?; cashier_token(&ctx.accounts.vault, &ctx.accounts.cashier.key())?;
    *ctx.accounts.cashier = DevnetCashier { authority: ADMIN, settlement, mint: DEVNET_USDC,
        bump: ctx.bumps.cashier, paused: false, daily_limit, day: Clock::get()?.unix_timestamp.div_euclid(86_400),
        paid_today: 0, max_claim };
    Ok(())
}
fn cashier_deposit(ctx: Context<DepositDevnetTokens>, reference: [u8; 32], tier: u8, quantity: u16) -> Result<()> {
    require!(cfg!(feature = "devnet"), CashierError::DevnetOnly);
    require!(!ctx.accounts.cashier.paused, CashierError::Paused);
    let amount = cashier_price(tier, quantity)?;
    cashier_mint(&ctx.accounts.mint)?; cashier_token(&ctx.accounts.source, &ctx.accounts.buyer.key())?;
    cashier_token(&ctx.accounts.vault, &ctx.accounts.cashier.key())?;
    cashier_transfer(ctx.accounts.source.to_account_info(), ctx.accounts.mint.to_account_info(),
        ctx.accounts.vault.to_account_info(), ctx.accounts.buyer.to_account_info(), ctx.accounts.token_program.to_account_info(), amount, &[])?;
    *ctx.accounts.receipt = DevnetDepositReceipt { buyer: ctx.accounts.buyer.key(), reference, tier, quantity, amount };
    Ok(())
}
fn cashier_withdraw(ctx: Context<WithdrawDevnetWinnings>, reference: [u8; 32], amount: u64) -> Result<()> {
    require!(cfg!(feature = "devnet"), CashierError::DevnetOnly);
    cashier_mint(&ctx.accounts.mint)?; cashier_token(&ctx.accounts.vault, &ctx.accounts.cashier.key())?;
    cashier_token(&ctx.accounts.destination, &ctx.accounts.wallet.key())?;
    ctx.accounts.cashier.reserve_payout(amount, Clock::get()?.unix_timestamp)?;
    let bump = [ctx.accounts.cashier.bump];
    cashier_transfer(ctx.accounts.vault.to_account_info(), ctx.accounts.mint.to_account_info(),
        ctx.accounts.destination.to_account_info(), ctx.accounts.cashier.to_account_info(), ctx.accounts.token_program.to_account_info(), amount, &[&[CASHIER_SEED, &bump]])?;
    *ctx.accounts.receipt = DevnetWithdrawalReceipt { wallet: ctx.accounts.wallet.key(), reference, amount };
    Ok(())
}

#[error_code]
pub enum CashierError {
    #[msg("Cashier is available in the devnet build only")] DevnetOnly,
    #[msg("Cashier authority must be a separate owner-approved signer")] InvalidAuthority,
    #[msg("Wrong devnet USDC mint or decimals")] InvalidMint,
    #[msg("Wrong canonical token account, token owner or mint")] InvalidTokenAccount,
    #[msg("Invalid token tier or purchase quantity")] InvalidPurchase,
    #[msg("Invalid or excessive payout amount")] InvalidAmount,
    #[msg("Cashier is paused")] Paused,
    #[msg("Cashier daily payout limit reached")] DailyLimit,
    #[msg("Clock cannot move backwards")] InvalidDay,
}

#[cfg(test)]
mod cashier_tests {
    use super::*;
    #[test]
    fn exact_prices_and_bounds() {
        assert_eq!(cashier_price(0, 1).unwrap(), 2_000_000);
        assert_eq!(cashier_price(1, 10).unwrap(), 40_000_000);
        assert_eq!(cashier_price(2, 1000).unwrap(), 6_000_000_000);
        assert!(cashier_price(3, 1).is_err()); assert!(cashier_price(0, 0).is_err()); assert!(cashier_price(0, 1001).is_err());
    }
    #[test]
    fn payouts_are_capped_and_midnight_does_not_erase_claim_receipts() {
        let mut state = DevnetCashier { authority: ADMIN, settlement: Pubkey::new_unique(), mint: DEVNET_USDC,
            bump: 1, paused: false, daily_limit: 4_000_000, day: 1, paid_today: 0, max_claim: 3_000_000 };
        state.reserve_payout(3_000_000, 86_401).unwrap();
        assert!(state.reserve_payout(2_000_000, 86_402).is_err()); assert_eq!(state.paid_today, 3_000_000);
        assert!(state.reserve_payout(1, 86_402).is_err()); assert!(state.reserve_payout(4_000_000, 86_402).is_err());
        state.reserve_payout(2_000_000, 172_801).unwrap(); assert_eq!(state.paid_today, 2_000_000);
        assert!(state.reserve_payout(1_000_000, 86_401).is_err()); state.paused = true;
        assert!(state.reserve_payout(1_000_000, 172_802).is_err());
    }
}
