/// <reference path="../common/stellar-sdk-contract.d.ts" />
import { Injectable, Logger } from '@nestjs/common';
import { Client } from '@stellar/stellar-sdk/contract';
import type { MethodOptions, AssembledTransaction, Result } from '@stellar/stellar-sdk/contract';
import { Networks } from '@stellar/stellar-sdk';
import { getFacilitatorSigner, withFacilitatorSubmissionLock } from '../common/facilitator-signer';
import { NETWORK_PASSPHRASE, RPC_URL, PAYMENT_CONTRACT_ID } from '../common/stellar-network';
import { toStroops } from '../common/money-rules';

interface PaymentContract {
  // Returns Result<u64, PaymentError> in Rust -- confirmed empirically
  // against a real testnet call (Ok { value: 4n }), not assumed from the
  // contract signature alone.
  record_payment(
    args: { merchant: string; payer: string; link_id: bigint; amount: bigint; tx_hash: Buffer },
    options?: MethodOptions,
  ): Promise<AssembledTransaction<Result<bigint>>>;
}

export interface AttestPaymentInput {
  merchantAddress: string;
  payerAddress: string;
  // The contract's own `link_id: u64` doesn't line up with links.id (a
  // UUID, which doesn't fit in a u64 at all) -- this is payments.muxed_id,
  // an already-per-merchant-sequential BIGINT, the closer semantic fit.
  // Naming collision, not a bug: the contract's "link_id" really means
  // "this merchant's payment sequence number."
  muxedId: string;
  netUsdc: string;
  txHash: string;
}

export interface AttestPaymentResult {
  success: boolean;
  onchainPaymentId?: string;
  transaction?: string;
  errorReason?: string;
}

// Calls the deployed-but-previously-unused `payment` contract's
// record_payment as a pure attestation, after a classic Stellar payment has
// already been independently confirmed by the reconciler -- see the
// contract's own doc comment ("an attestation layer, not an escrow"). Never
// blocks or delays the payment that already fully settled to the merchant;
// a failure here just leaves the row for
// PaymentAttestationSweeperService's next pass to retry.
//
// Real, hard-won finding, not assumed: record_payment requires the
// facilitator to satisfy require_auth() for *itself* (as the contract's
// stored admin) -- the first call in this codebase where the facilitator
// authorizes something as itself, rather than either needing no auth at all
// (channel checkpoint/finalize_close) or relaying an already-signed auth
// entry from someone else (channel open/close). The hand-rolled
// TransactionBuilder pattern channel.service.ts/facilitator-sweep.service.ts
// use for those cases never attaches a Soroban authorization entry at all,
// which is fine when none is needed but produces a real, confirmed-live
// "Unauthorized function call for address <facilitator>" contract trap here
// (decoded from a real failed testnet transaction's diagnostic events
// before this was rewritten -- not reasoned about). The high-level
// Client/AssembledTransaction API (same family onchain-compliance.ts
// already uses for reads) handles this correctly: `signAndSend()` collects
// and signs whatever auth entries simulation says the invoker itself needs,
// using the signTransaction/signAuthEntry pair wired in below.
//
// This is also the first live call site in this codebase for
// getFacilitatorSigner()'s signAuthEntry path. The KMS-backed signer
// (kms-ed25519-signer.ts) has that as a documented, intentional throw --
// "no live call site... yet" -- so this feature works today against the
// active raw-key signer (createEd25519Signer's real basicNodeSigner-backed
// implementation) but is a new, real blocker on the facilitator-key
// hardening's Phase 1 KMS cutover until signAuthEntry is actually
// implemented there.
@Injectable()
export class PaymentAttestationService {
  private readonly logger = new Logger(PaymentAttestationService.name);
  private clientPromise: Promise<Client & PaymentContract> | null = null;

  private async getClient(): Promise<Client & PaymentContract> {
    if (!this.clientPromise) {
      this.clientPromise = (async () => {
        const signer = await getFacilitatorSigner();
        return Client.from<PaymentContract>({
          contractId: PAYMENT_CONTRACT_ID,
          networkPassphrase: NETWORK_PASSPHRASE,
          rpcUrl: RPC_URL,
          publicKey: signer.address,
          signTransaction: signer.signTransaction,
          signAuthEntry: signer.signAuthEntry,
        });
      })();
    }
    return this.clientPromise;
  }

  async attest(input: AttestPaymentInput): Promise<AttestPaymentResult> {
    // Exact bigint stroops via the shared converter -- never a float
    // multiply-then-round, which silently loses precision above ~900,719
    // USDC (Number.MAX_SAFE_INTEGER boundary) and would be recorded
    // permanently on an immutable on-chain call.
    const amountStroops = toStroops(input.netUsdc);

    return withFacilitatorSubmissionLock(async () => {
      try {
        const client = await this.getClient();
        const assembled = await client.record_payment({
          merchant: input.merchantAddress,
          payer: input.payerAddress,
          link_id: BigInt(input.muxedId),
          amount: amountStroops,
          tx_hash: Buffer.from(input.txHash, 'hex'),
        });
        const sent = await assembled.signAndSend();
        if (!sent.result.isOk()) {
          return { success: false, errorReason: `contract_error_${sent.result.unwrapErr().message}` };
        }
        return {
          success: true,
          onchainPaymentId: String(sent.result.unwrap()),
          transaction: sent.sendTransactionResponse?.hash,
        };
      } catch (err) {
        this.logger.error(`attestation failed: ${err}`);
        // Same reasoning as onchain-compliance.ts's getClient(): a cached
        // client wrapping a hung/poisoned RPC connection shouldn't wedge
        // every future attestation for the life of the process.
        this.clientPromise = null;
        return { success: false, errorReason: 'attestation_failed' };
      }
    });
  }
}
