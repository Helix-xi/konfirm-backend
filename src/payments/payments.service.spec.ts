import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { PaymentsService } from './payments.service';
import { LinksService } from '../links/links.service';
import { StellarService } from '../stellar/stellar.service';
import { ConfigService } from '@nestjs/config';

describe('PaymentsService', () => {
  let service: PaymentsService;
  let linksService: { findOne: jest.Mock };
  let stellarService: { buildPaymentTx: jest.Mock; buildPayUri: jest.Mock };

  const baseLink = {
    id: 'link-1',
    merchantId: 'merchant-1',
    destination: 'GDEST...',
    amount: '10.0000000',
    assetCode: 'XLM',
    assetIssuer: null,
    memo: null,
    feeBps: 0,
    active: true,
  };

  beforeEach(async () => {
    linksService = { findOne: jest.fn() };
    stellarService = {
      buildPaymentTx: jest.fn().mockResolvedValue('AAAA...xdr'),
      buildPayUri: jest.fn().mockReturnValue('web+stellar:pay?destination=GDEST'),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PaymentsService,
        { provide: LinksService, useValue: linksService },
        { provide: StellarService, useValue: stellarService },
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string) => {
              if (key === 'PLATFORM_FEE_ADDRESS') return 'GPLATFORM...';
              if (key === 'DEFAULT_FEE_BPS') return '0';
              return undefined;
            }),
          },
        },
      ],
    }).compile();

    service = module.get<PaymentsService>(PaymentsService);
  });

  describe('buildPayUri', () => {
    it('returns a SEP-7 pay URI for a link with zero effective fee', async () => {
      linksService.findOne.mockResolvedValue({ ...baseLink, feeBps: 0 });

      const uri = await service.buildPayUri('link-1', undefined);

      expect(uri).toBe('web+stellar:pay?destination=GDEST');
      expect(stellarService.buildPayUri).toHaveBeenCalledTimes(1);
    });

    it('refuses to build a fee-free SEP-7 URI when the link has a non-zero fee', async () => {
      linksService.findOne.mockResolvedValue({ ...baseLink, feeBps: 250 });

      await expect(service.buildPayUri('link-1', undefined)).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(stellarService.buildPayUri).not.toHaveBeenCalled();
    });
  });
});
