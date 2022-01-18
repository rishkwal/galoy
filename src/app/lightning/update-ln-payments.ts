import { LndService } from "@services/lnd"
import { baseLogger } from "@services/logger"
import { LnPaymentsRepository } from "@services/mongoose/ln-payments"

export const updateLnPayments = async (): Promise<true | ApplicationError> => {
  let processedLnPaymentsHashes: PaymentHash[] | ApplicationError = []

  const incompleteLnPayments = await LnPaymentsRepository().listIncomplete()
  if (incompleteLnPayments instanceof Error) return incompleteLnPayments

  const lndService = LndService()
  if (lndService instanceof Error) return lndService
  const pubkeys = lndService.listActivePubkeys()

  let lastSeenCursorByPubkey: ListSettledAndFailedLnPaymentsByPubkeyArgs = pubkeys.map(
    (pubkey) => ({
      settledAfter: undefined,
      failedAfter: undefined,
      pubkey,
    }),
  )

  while (
    processedLnPaymentsHashes.length < incompleteLnPayments.length &&
    lastSeenCursorByPubkey.length
  ) {
    ;({ lastSeenCursorByPubkey, processedLnPaymentsHashes } =
      await fetchAndUpdatePayments({
        incompleteLnPayments,
        lastSeenCursorByPubkey,
        lndService,
      }))
  }

  return true
}

const fetchAndUpdatePayments = async ({
  incompleteLnPayments,
  lastSeenCursorByPubkey,
  lndService,
}: {
  incompleteLnPayments: PersistedLnPaymentLookup[]
  lastSeenCursorByPubkey: ListSettledAndFailedLnPaymentsByPubkeyArgs
  lndService: ILightningService
}) => {
  // Fetch from Lightning service
  const results = await lndService.listSettledAndFailedPaymentsByPubkey(
    lastSeenCursorByPubkey,
  )

  // Update cursors & drop completed pubkeys
  const updatedLastSeenCursorByPubkey = results
    .map(
      ({
        settled,
        failed,
        pubkey,
      }): ContinueListSettledAndFailedLnPaymentsByPubkeyArg => ({
        settledAfter:
          settled instanceof Error || settled.endCursor === false
            ? false
            : settled.endCursor,
        failedAfter:
          failed instanceof Error || failed.endCursor === false
            ? false
            : failed.endCursor,
        pubkey,
      }),
    )
    .filter(({ settledAfter, failedAfter }) => settledAfter || failedAfter)

  // Update LnPayments repository
  const processedLnPaymentsHashes: PaymentHash[] | ApplicationError = []
  for (const { settled, failed } of results) {
    const lnPayments: LnPaymentLookup[] = [
      ...(settled instanceof Error ? [] : settled.lnPayments),
      ...(failed instanceof Error ? [] : failed.lnPayments),
    ]

    for (const payment of lnPayments) {
      let persistedPaymentLookup = incompleteLnPayments.find(
        (elem) => elem.paymentHash === payment.paymentHash,
      )
      if (!persistedPaymentLookup) continue

      persistedPaymentLookup = Object.assign(persistedPaymentLookup, {
        ...payment,
        paymentRequest: payment.paymentRequest || persistedPaymentLookup.paymentRequest,
        isCompleteRecord: true,
      })
      const updatedPaymentLookup = await LnPaymentsRepository().update(
        persistedPaymentLookup,
      )
      if (updatedPaymentLookup instanceof Error) {
        baseLogger.error(
          { error: updatedPaymentLookup },
          "Could not update LnPayments repository",
        )
        continue
      }
      processedLnPaymentsHashes.push(payment.paymentHash)
    }
  }

  return {
    lastSeenCursorByPubkey: updatedLastSeenCursorByPubkey,
    processedLnPaymentsHashes,
  }
}
