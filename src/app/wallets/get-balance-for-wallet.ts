import { LedgerService } from "@services/ledger"

import { updatePendingPaymentsByWalletId } from "./update-pending-payments"

export const getBalanceForWallet = async ({
  walletId,
  lock,
  logger,
}: {
  walletId: WalletId
  lock?: DistributedLock
  logger: Logger
}): Promise<Satoshis | ApplicationError> => {
  const updatePaymentsResult = await updatePendingPaymentsByWalletId({
    walletId,
    lock,
    logger,
  })
  if (updatePaymentsResult instanceof Error) return updatePaymentsResult

  return LedgerService().getWalletBalance(walletId)
}
