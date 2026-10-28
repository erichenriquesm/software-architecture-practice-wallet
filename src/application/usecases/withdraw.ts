import { AccountId } from '../../domain/valueObjects/accountId.js';
import { AssetId } from '../../domain/valueObjects/assetId.js';
import { Quantity } from '../../domain/valueObjects/quantity.js';
import type { Clock } from '../contracts/clock.js';
import type { MarketCatalog } from '../contracts/marketCatalog.js';
import { retryOnConflict } from './retryOnConflict.js';
import type { WalletStore } from './walletStore.js';

export interface WithdrawInput {
  readonly accountId: string;
  readonly assetId: string;
  readonly quantity: string;
}

export class Withdraw {
  constructor(
    private readonly walletStore: WalletStore,
    private readonly marketCatalog: MarketCatalog,
    private readonly clock: Clock,
  ) {}

  async execute(movement: WithdrawInput): Promise<void> {
    const accountId = AccountId.from(movement.accountId);
    const asset = AssetId.from(movement.assetId);
    const quantity = Quantity.from(movement.quantity);
    const precision = this.marketCatalog.precisionOf(asset);

    await retryOnConflict(async () => {
      const wallet = await this.walletStore.loadOrOpen(accountId);
      wallet.withdraw(asset, quantity, precision, this.clock.now());
      await this.walletStore.persist(wallet);
    });
  }
}
