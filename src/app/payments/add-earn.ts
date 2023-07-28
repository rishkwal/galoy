import { getRewardsConfig, OnboardingEarn } from "@config"
import { IPMetadataValidator } from "@domain/accounts-ips/ip-metadata-validator"
import {
  InvalidIPMetadataForRewardError,
  InvalidPhoneMetadataForRewardError,
  InvalidQuizQuestionIdError,
  NoBtcWalletExistsForAccountError,
} from "@domain/errors"
import { WalletCurrency } from "@domain/shared"
import { PhoneMetadataValidator } from "@domain/users/phone-metadata-validator"
import { getFunderWalletId } from "@services/ledger/caching"
import {
  AccountsRepository,
  RewardsRepository,
  WalletsRepository,
  UsersRepository,
} from "@services/mongoose"
import { AccountsIpsRepository } from "@services/mongoose/accounts-ips"

import { intraledgerPaymentSendWalletIdForBtcWallet } from "./send-intraledger"

export const addEarn = async ({
  quizQuestionId: quizQuestionIdString,
  accountId,
}: {
  quizQuestionId: string
  accountId: AccountId /* AccountId: aid validation */
}): Promise<QuizQuestion | ApplicationError> => {
  const rewardsConfig = getRewardsConfig()

  // TODO: quizQuestionId checkedFor
  const quizQuestionId = quizQuestionIdString as QuizQuestionId

  const amount = OnboardingEarn[quizQuestionId]
  if (!amount) return new InvalidQuizQuestionIdError()

  const funderWalletId = await getFunderWalletId()
  const funderWallet = await WalletsRepository().findById(funderWalletId)
  if (funderWallet instanceof Error) return funderWallet
  const funderAccount = await AccountsRepository().findById(funderWallet.accountId)
  if (funderAccount instanceof Error) return funderAccount

  const recipientAccount = await AccountsRepository().findById(accountId)
  if (recipientAccount instanceof Error) return recipientAccount

  const user = await UsersRepository().findById(recipientAccount.kratosUserId)
  if (user instanceof Error) return user

  const validatedPhoneMetadata = PhoneMetadataValidator(rewardsConfig).validateForReward(
    user.phoneMetadata,
  )

  if (validatedPhoneMetadata instanceof Error)
    return new InvalidPhoneMetadataForRewardError(validatedPhoneMetadata.name)

  const accountIP = await AccountsIpsRepository().findLastByAccountId(recipientAccount.id)
  if (accountIP instanceof Error) return accountIP

  const validatedIPMetadata = IPMetadataValidator(rewardsConfig).validateForReward(
    accountIP.metadata,
  )
  if (validatedIPMetadata instanceof Error) {
    return new InvalidIPMetadataForRewardError(validatedIPMetadata.name)
  }

  const recipientWallets = await WalletsRepository().listByAccountId(accountId)
  if (recipientWallets instanceof Error) return recipientWallets

  const recipientBtcWallet = recipientWallets.find(
    (wallet) => wallet.currency === WalletCurrency.Btc,
  )
  if (recipientBtcWallet === undefined) return new NoBtcWalletExistsForAccountError()
  const recipientWalletId = recipientBtcWallet.id

  const shouldGiveReward = await RewardsRepository(accountId).add(quizQuestionId)
  if (shouldGiveReward instanceof Error) return shouldGiveReward

  const payment = await intraledgerPaymentSendWalletIdForBtcWallet({
    senderWalletId: funderWalletId,
    recipientWalletId,
    amount,
    memo: quizQuestionId,
    senderAccount: funderAccount,
  })
  if (payment instanceof Error) return payment

  return { id: quizQuestionId, earnAmount: amount }
}