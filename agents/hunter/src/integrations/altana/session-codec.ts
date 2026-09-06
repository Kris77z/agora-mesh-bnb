import {
  signerFromPrivateKey,
  type Session,
  type SessionPermissions
} from "@altananetwork/sdk";
import type { AuthorityRecord, HexAddress, HexHash } from "@rebel/shared";

export interface PersistedAltanaSession {
  version: 1;
  authority: AuthorityRecord;
  signerPrivateKey: HexHash;
  session: {
    walletAddress: HexAddress;
    publicKey: HexHash;
    expiry: number;
    permissions: {
      calls?: Array<{ to?: HexAddress; signature?: string }>;
      spend?: Array<{ limit: string; period: "minute" | "hour" | "day" | "week" | "month" | "year"; token?: HexAddress }>;
    };
  };
}

function requireHex(value: string, label: string): `0x${string}` {
  if (!/^0x[0-9a-fA-F]+$/.test(value)) {
    throw new Error(`${label} must be a hex string`);
  }
  return value as `0x${string}`;
}

export function createPersistedAltanaSession(input: {
  authority: AuthorityRecord;
  session: Session;
  signerPrivateKey: `0x${string}`;
}): PersistedAltanaSession {
  const spend = input.session.permissions.spend?.map((permission) => ({
    limit: permission.limit.toString(),
    period: permission.period,
    token: permission.token
  }));
  return {
    version: 1,
    authority: input.authority,
    signerPrivateKey: input.signerPrivateKey,
    session: {
      walletAddress: input.session.walletAddress,
      publicKey: input.session.publicKey,
      expiry: input.session.expiry,
      permissions: {
        calls: input.session.permissions.calls?.map((permission) => ({ ...permission })),
        spend
      }
    }
  };
}

export function restoreAltanaSession(record: PersistedAltanaSession): Session {
  if (record.version !== 1) {
    throw new Error(`Unsupported Altana session record version: ${String(record.version)}`);
  }
  const privateKey = requireHex(record.signerPrivateKey, "session signer private key");
  if (!/^0x[0-9a-fA-F]{64}$/.test(privateKey)) {
    throw new Error("Session signer private key must be 32 bytes");
  }
  const signer = signerFromPrivateKey(privateKey);
  if (signer.publicKey.toLowerCase() !== record.session.publicKey.toLowerCase()) {
    throw new Error("Session signer does not match the persisted public key");
  }
  if (!Number.isSafeInteger(record.session.expiry) || record.session.expiry <= 0) {
    throw new Error("Session expiry is invalid");
  }

  const permissions: SessionPermissions = {
    calls: record.session.permissions.calls?.map((permission) => {
      if (!permission.to && !permission.signature) {
        throw new Error("Call permission must include a target or signature");
      }
      if (permission.to && permission.signature) {
        return { to: requireHex(permission.to, "call target"), signature: permission.signature };
      }
      return permission.to
        ? { to: requireHex(permission.to, "call target") }
        : { signature: permission.signature! };
    }),
    spend: record.session.permissions.spend?.map((permission) => {
      if (!/^\d+$/.test(permission.limit)) {
        throw new Error("Spend limit must be an integer string");
      }
      return {
        limit: BigInt(permission.limit),
        period: permission.period,
        token: permission.token ? requireHex(permission.token, "spend token") : undefined
      };
    })
  };

  return {
    walletAddress: requireHex(record.session.walletAddress, "wallet address"),
    signer,
    publicKey: requireHex(record.session.publicKey, "session public key"),
    permissions,
    expiry: record.session.expiry
  };
}
