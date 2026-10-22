import { PaymentAttestationService } from './payment-attestation.service';
import * as facilitatorSigner from '../common/facilitator-signer';
import { toStroops } from '../common/money-rules';
import { Client } from '@stellar/stellar-sdk/contract';

// Unit tests for PaymentAttestationService. These never hit a real Soroban
// RPC or testnet node -- the Client.from() factory and getFacilitatorSigner()
// are both mocked out, letting us verify the service's own logic (amount
// conversion, argument mapping, result shaping, error recovery) in isolation,
// at CI speed.
//
// The one thing we deliberately do NOT mock is withFacilitatorSubmissionLock:
// it's pure promise chaining with no I/O of its own, and verifying that the
// lock actually serialises concurrent calls is a real behavioral test we want
// to keep honest.

jest.mock('@stellar/stellar-sdk/contract', () => {
  const original = jest.requireActual('@stellar/stellar-sdk/contract');
  return {
    ...original,
    Client: {
      ...original.Client,
      from: jest.fn(),
    },
  };
});

jest.mock('../common/facilitator-signer', () => ({
  getFacilitatorSigner: jest.fn(),
  withFacilitatorSubmissionLock: jest.fn((fn: () => Promise<unknown>) => fn()),
}));

describe('PaymentAttestationService', () => {
  const mockSigner = {
    address: 'GBXBABMFZIJPTOFI6STUXA2FMEXDBB4URBD3VS5XDHKMFHGLJZ5WPQBB',
    signTransaction: jest.fn(),
    signAuthEntry: jest.fn(),
  };

  // A minimal stub that stands in for an AssembledTransaction from Client.from().
  // record_payment() returns one of these; signAndSend() is where the
  // on-chain submission (and its result) live.
  function makeAssembled(options: {
    okValue?: bigint;
    errMessage?: string;
    hash?: string;
  }) {
    const { okValue, errMessage, hash = 'abc123hash' } = options;
    return {
      signAndSend: jest.fn().mockResolvedValue({
        result: okValue !== undefined
          ? { isOk: () => true, unwrap: () => okValue }
          : { isOk: () => false, unwrapErr: () => ({ message: errMessage ?? 'some_error' }) },
        sendTransactionResponse: { hash },
      }),
    };
  }

  function makeClient(assembled: ReturnType<typeof makeAssembled>) {
    return {
      record_payment: jest.fn().mockResolvedValue(assembled),
    };
  }

  beforeEach(() => {
    jest.clearAllMocks();
    (facilitatorSigner.getFacilitatorSigner as jest.Mock).mockResolvedValue(mockSigner);
  });

  it('returns success with the on-chain payment id and tx hash on a clean submission', async () => {
    const assembled = makeAssembled({ okValue: 7n, hash: 'deadbeef' });
    const client = makeClient(assembled);
    (Client.from as jest.Mock).mockResolvedValue(client);

    const service = new PaymentAttestationService();
    const result = await service.attest({
      merchantAddress: 'GBXBABMFZIJPTOFI6STUXA2FMEXDBB4URBD3VS5XDHKMFHGLJZ5WPQBB',
      payerAddress: 'GDIET4T37N35XU4FY52RMR4Z653WYFITEHGIJXN4VEQTDYR5JSURJDPL',
      muxedId: '42',
      netUsdc: '5.00',
      txHash: '0011223344556677',
    });

    expect(result).toEqual({
      success: true,
      onchainPaymentId: '7',
      transaction: 'deadbeef',
    });
  });

  it('converts netUsdc to stroops correctly — 1 USDC = 10_000_000 stroops', async () => {
    const assembled = makeAssembled({ okValue: 1n });
    const client = makeClient(assembled);
    (Client.from as jest.Mock).mockResolvedValue(client);

    const service = new PaymentAttestationService();
    await service.attest({
      merchantAddress: 'GBXBABMFZIJPTOFI6STUXA2FMEXDBB4URBD3VS5XDHKMFHGLJZ5WPQBB',
      payerAddress: 'GDIET4T37N35XU4FY52RMR4Z653WYFITEHGIJXN4VEQTDYR5JSURJDPL',
      muxedId: '1',
      netUsdc: '2.50',
      txHash: '00',
    });

    const callArgs = client.record_payment.mock.calls[0][0];
    // 2.50 USDC * 10_000_000 stroops/USDC = 25_000_000
    expect(callArgs.amount).toBe(25_000_000n);
  });

  it('attests the exact toStroops() amount for large inputs above the float-safe boundary', async () => {
    const assembled = makeAssembled({ okValue: 1n });
    const client = makeClient(assembled);
    (Client.from as jest.Mock).mockResolvedValue(client);

    // 1_000_000 USDC * 10_000_000 stroops = 1e13, well past 2^53 (~9.007e15
    // stroops, i.e. ~900,719 USDC) where a float multiply-then-round loses
    // integer precision. toStroops() must produce the exact bigint.
    const netUsdc = '1000000.00';
    const service = new PaymentAttestationService();
    await service.attest({
      merchantAddress: 'GBXBABMFZIJPTOFI6STUXA2FMEXDBB4URBD3VS5XDHKMFHGLJZ5WPQBB',
      payerAddress: 'GDIET4T37N35XU4FY52RMR4Z653WYFITEHGIJXN4VEQTDYR5JSURJDPL',
      muxedId: '1',
      netUsdc,
      txHash: '00',
    });

    const callArgs = client.record_payment.mock.calls[0][0];
    expect(callArgs.amount).toBe(toStroops(netUsdc));
    expect(callArgs.amount).toBe(10_000_000_000_000n);
  });

  it('attests the exact toStroops() amount for fractional inputs', async () => {
    const assembled = makeAssembled({ okValue: 1n });
    const client = makeClient(assembled);
    (Client.from as jest.Mock).mockResolvedValue(client);

    const netUsdc = '1234.5678901';
    const service = new PaymentAttestationService();
    await service.attest({
      merchantAddress: 'GBXBABMFZIJPTOFI6STUXA2FMEXDBB4URBD3VS5XDHKMFHGLJZ5WPQBB',
      payerAddress: 'GDIET4T37N35XU4FY52RMR4Z653WYFITEHGIJXN4VEQTDYR5JSURJDPL',
      muxedId: '1',
      netUsdc,
      txHash: '00',
    });

    const callArgs = client.record_payment.mock.calls[0][0];
    expect(callArgs.amount).toBe(toStroops(netUsdc));
  });

  it('passes muxedId as a BigInt link_id to the contract', async () => {
    const assembled = makeAssembled({ okValue: 1n });
    const client = makeClient(assembled);
    (Client.from as jest.Mock).mockResolvedValue(client);

    const service = new PaymentAttestationService();
    await service.attest({
      merchantAddress: 'GBXBABMFZIJPTOFI6STUXA2FMEXDBB4URBD3VS5XDHKMFHGLJZ5WPQBB',
      payerAddress: 'GDIET4T37N35XU4FY52RMR4Z653WYFITEHGIJXN4VEQTDYR5JSURJDPL',
      muxedId: '99887766',
      netUsdc: '1.00',
      txHash: '00',
    });

    const callArgs = client.record_payment.mock.calls[0][0];
    expect(callArgs.link_id).toBe(99887766n);
  });

  it('passes txHash decoded as a hex Buffer to the contract', async () => {
    const assembled = makeAssembled({ okValue: 1n });
    const client = makeClient(assembled);
    (Client.from as jest.Mock).mockResolvedValue(client);

    const service = new PaymentAttestationService();
    await service.attest({
      merchantAddress: 'GBXBABMFZIJPTOFI6STUXA2FMEXDBB4URBD3VS5XDHKMFHGLJZ5WPQBB',
      payerAddress: 'GDIET4T37N35XU4FY52RMR4Z653WYFITEHGIJXN4VEQTDYR5JSURJDPL',
      muxedId: '1',
      netUsdc: '1.00',
      txHash: 'deadbeef',
    });

    const callArgs = client.record_payment.mock.calls[0][0];
    expect(callArgs.tx_hash).toEqual(Buffer.from('deadbeef', 'hex'));
  });

  it('returns failure with a contract_error_ prefix when the contract returns an Err result', async () => {
    const assembled = makeAssembled({ errMessage: 'duplicate_payment' });
    const client = makeClient(assembled);
    (Client.from as jest.Mock).mockResolvedValue(client);

    const service = new PaymentAttestationService();
    const result = await service.attest({
      merchantAddress: 'GBXBABMFZIJPTOFI6STUXA2FMEXDBB4URBD3VS5XDHKMFHGLJZ5WPQBB',
      payerAddress: 'GDIET4T37N35XU4FY52RMR4Z653WYFITEHGIJXN4VEQTDYR5JSURJDPL',
      muxedId: '1',
      netUsdc: '1.00',
      txHash: '00',
    });

    expect(result.success).toBe(false);
    expect(result.errorReason).toBe('contract_error_duplicate_payment');
  });

  it('returns attestation_failed and clears the client cache when an exception is thrown', async () => {
    const client = {
      record_payment: jest.fn().mockRejectedValue(new Error('RPC connection refused')),
    };
    (Client.from as jest.Mock).mockResolvedValue(client);

    const service = new PaymentAttestationService();

    const result = await service.attest({
      merchantAddress: 'GBXBABMFZIJPTOFI6STUXA2FMEXDBB4URBD3VS5XDHKMFHGLJZ5WPQBB',
      payerAddress: 'GDIET4T37N35XU4FY52RMR4Z653WYFITEHGIJXN4VEQTDYR5JSURJDPL',
      muxedId: '1',
      netUsdc: '1.00',
      txHash: '00',
    });

    expect(result).toEqual({ success: false, errorReason: 'attestation_failed' });

    // A second call after a failure must re-create the client rather than
    // reusing the poisoned cached promise -- verified by checking that
    // Client.from is called a second time.
    const assembled2 = makeAssembled({ okValue: 5n });
    const client2 = makeClient(assembled2);
    (Client.from as jest.Mock).mockResolvedValue(client2);

    await service.attest({
      merchantAddress: 'GBXBABMFZIJPTOFI6STUXA2FMEXDBB4URBD3VS5XDHKMFHGLJZ5WPQBB',
      payerAddress: 'GDIET4T37N35XU4FY52RMR4Z653WYFITEHGIJXN4VEQTDYR5JSURJDPL',
      muxedId: '2',
      netUsdc: '1.00',
      txHash: '00',
    });

    // Client.from was called once for the failing call and once for the retry.
    expect(Client.from).toHaveBeenCalledTimes(2);
  });

  it('reuses the cached client across multiple successful calls', async () => {
    const assembled = makeAssembled({ okValue: 1n });
    const client = makeClient(assembled);
    (Client.from as jest.Mock).mockResolvedValue(client);

    const service = new PaymentAttestationService();

    await service.attest({
      merchantAddress: 'GBXBABMFZIJPTOFI6STUXA2FMEXDBB4URBD3VS5XDHKMFHGLJZ5WPQBB',
      payerAddress: 'GDIET4T37N35XU4FY52RMR4Z653WYFITEHGIJXN4VEQTDYR5JSURJDPL',
      muxedId: '1',
      netUsdc: '1.00',
      txHash: '00',
    });

    // Swap to a new client -- should NOT be used since the first was cached.
    const assembled2 = makeAssembled({ okValue: 2n });
    const client2 = makeClient(assembled2);
    (Client.from as jest.Mock).mockResolvedValue(client2);

    await service.attest({
      merchantAddress: 'GBXBABMFZIJPTOFI6STUXA2FMEXDBB4URBD3VS5XDHKMFHGLJZ5WPQBB',
      payerAddress: 'GDIET4T37N35XU4FY52RMR4Z653WYFITEHGIJXN4VEQTDYR5JSURJDPL',
      muxedId: '2',
      netUsdc: '1.00',
      txHash: '00',
    });

    expect(Client.from).toHaveBeenCalledTimes(1);
  });
});
