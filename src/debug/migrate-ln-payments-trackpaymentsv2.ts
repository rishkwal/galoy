/**
 * how to run:
 *	. ./.envrc && yarn ts-node \
 *		--files \
 *			-r tsconfig-paths/register \
 *			-r src/services/tracing.ts \
 *		src/debug/migrate-ln-payments-trackpaymentsv2.ts
 */

import { isUp } from "@services/lnd/health"
import { params as unauthParams } from "@services/lnd/unauth"
import { PaymentNotFoundError, PaymentStatus } from "@domain/bitcoin/lightning"
import { CouldNotFindError } from "@domain/errors"
import { LedgerService } from "@services/ledger"
import { LndService } from "@services/lnd"
import { baseLogger } from "@services/logger"
import { LnPaymentsRepository } from "@services/mongoose"
import {
  addAttributesToCurrentSpan,
  addEventToCurrentSpan,
  asyncRunInSpan,
  SemanticAttributes,
} from "@services/tracing"
import { setupMongoConnection } from "@services/mongodb"

let lndService

export const main = async (): Promise<true> =>
  asyncRunInSpan(
    "debug.migrateLnPaymentsFromLndByHash",
    { [SemanticAttributes.CODE_FUNCTION]: "debug.migrateLnPaymentsFromLndByHash" },
    async (): Promise<true> => {
      lndService = LndService()
      if (lndService instanceof Error) return true

      const paymentHashes = await LedgerService().listAllPaymentHashes()
      for await (const paymentHash of paymentHashes) {
        const res = await migrateLnPayment(paymentHash)
        if (res instanceof Error) break
      }
      return true
    },
  )

const migrateLnPayment = async (
  paymentHash: PaymentHash | LightningServiceError,
): Promise<true | LightningServiceError> =>
  asyncRunInSpan(
    "debug.migrateLnPayment",
    {
      [SemanticAttributes.CODE_FUNCTION]: "debug.migrateLnPayment",
      "migrateLnPayment.paymentHash":
        paymentHash instanceof Error ? paymentHash.name : paymentHash,
    },
    async (): Promise<true | LightningServiceError> => {
      if (paymentHash instanceof Error) return paymentHash

      // Check if hash exists in lnPayments repo
      const lnPaymentsRepo = LnPaymentsRepository()
      const lnPaymentExists = await lnPaymentsRepo.findByPaymentHash(paymentHash)
      if (!(lnPaymentExists instanceof CouldNotFindError)) {
        addAttributesToCurrentSpan({
          "migrateLnPayment.skip": true,
        })
        addEventToCurrentSpan(`Payment already exists: ${paymentHash}`)
        return true
      }

      // Fetch payment from lnd
      const payment = await lndService.lookupPayment({
        pubkey: lndService.defaultPubkey(),
        paymentHash,
      })
      if (payment instanceof PaymentNotFoundError) {
        addAttributesToCurrentSpan({ error: true })
        addEventToCurrentSpan(
          `Couldn't find hash ${paymentHash.substring(0, 5)}... in lnd`,
        )
        return true
      }
      if (payment instanceof Error) return payment

      // Add payment to LnPayments collection
      const partialLnPayment = {
        paymentHash,
        paymentRequest: undefined,
        sentFromPubkey: lndService.defaultPubkey(),
        createdAt: undefined,
      }
      const newLnPayment =
        payment.status === PaymentStatus.Pending
          ? partialLnPayment
          : payment.status === PaymentStatus.Failed
          ? {
              ...partialLnPayment,
              status: PaymentStatus.Failed,
              confirmedDetails: undefined,
              attempts: undefined,
              isCompleteRecord: true,
            }
          : {
              ...partialLnPayment,
              createdAt: payment.createdAt,
              status: payment.status,
              milliSatsAmount: payment.milliSatsAmount,
              roundedUpAmount: payment.roundedUpAmount,
              confirmedDetails: payment.confirmedDetails,
              attempts: payment.attempts, // will be null, only comes from getPayments
              isCompleteRecord: true,
            }

      const updatedPaymentLookup = await LnPaymentsRepository().persistNew(newLnPayment)
      if (updatedPaymentLookup instanceof Error) {
        baseLogger.error(
          { error: updatedPaymentLookup },
          "Could not update LnPayments repository",
        )
        addAttributesToCurrentSpan({ error: true })
        addEventToCurrentSpan(
          `Could not update LnPayments repository (${updatedPaymentLookup.name})`,
        )
        return true
      }

      addAttributesToCurrentSpan({
        "migrateLnPayment.success": `persistedNew: ${payment.paymentHash}`,
      })
      return true
    },
  )

setupMongoConnection(false)
  .then(async (mongoose) => {
    await Promise.all(unauthParams.map((lndParams) => isUp(lndParams)))
    await main()
    if (mongoose) await mongoose.connection.close()
  })
  .catch((err) => console.log(err))
