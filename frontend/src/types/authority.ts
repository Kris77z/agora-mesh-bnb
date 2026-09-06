export type AuthorityStatus = 'active' | 'expired' | 'revoked' | 'invalid';

export interface AuthorityAsset {
  chainId: number;
  kind: 'native' | 'erc20';
  address?: string;
  symbol: string;
  decimals: number;
}

export interface AuthorityRecord {
  authorityId: string;
  walletAddress: string;
  sessionPublicKey: string;
  chainId: number;
  allowedCalls: Array<{ to: string; selectors?: string[] }>;
  spendLimits: Array<{
    asset: AuthorityAsset;
    limit: string;
    period: 'total' | 'day';
  }>;
  expiry: number;
  status: AuthorityStatus;
  grantTxHash?: string;
  revokeTxHash?: string;
  createdAt: number;
}

export interface AuthorityTransactionEvidence {
  txHash: string;
  blockNumber: number;
  timestamp: number;
  recipient: string;
  amount: string;
  serviceId?: string;
}

export interface AuthoritySpendSummary {
  asset: AuthorityAsset;
  period: 'total' | 'day';
  limit: string;
  spent: string;
  remaining: string;
  evidenceSource: 'x402-receipt-store' | 'erc20-transfer-logs' | 'unsupported';
  transactions: AuthorityTransactionEvidence[];
}

export interface AuthorityNegativeTestEvidence {
  kind: 'erc20-transfer';
  recipient: string;
  amount: string;
  testedAt: number;
  rejected: boolean;
  rejection?: string;
  unexpectedTxHash?: string;
}

export interface AuthorityRevocationEvidence {
  checkerApprovalTxHash: string;
  permit2AllowanceTxHash: string;
  sessionRevokeTxHash: string;
  negativeTest?: AuthorityNegativeTestEvidence;
  sessionMaterialDeleted: boolean;
}

export interface AuthoritySnapshot {
  authority: AuthorityRecord;
  now: number;
  spending: AuthoritySpendSummary[] | { error: string };
  revocation?: AuthorityRevocationEvidence;
}
