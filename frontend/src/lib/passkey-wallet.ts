import type {PasskeyCredential} from '@altananetwork/sdk';
export type PasskeyWallet = {version: 1; address: `0x${string}`; credential: PasskeyCredential};
export const passkeyWalletStorage = 'agora.passkey-wallet.v1';
export const passkeyWalletEvent = 'agora:passkey-wallet';
export function readPasskeyWallet(): PasskeyWallet | undefined {
  try {
    const raw=localStorage.getItem(passkeyWalletStorage);
    if (!raw) return;
    const wallet=JSON.parse(raw) as PasskeyWallet;
    if(wallet.version===1 && /^0x[0-9a-fA-F]{40}$/.test(wallet.address) && wallet.credential?.kind==='webauthn') return wallet;
  } catch { /* Missing or malformed local wallet must be recovered on device. */ }
}
export async function connectPasskeyWallet(recover=false): Promise<PasskeyWallet> {
  if (!window.isSecureContext || !window.PublicKeyCredential) throw new Error('Passkeys require HTTPS and a compatible browser.');
  const sdk=await import('@altananetwork/sdk');
  const client=sdk.createClient({chains:[{...sdk.BNB_TESTNET,relayUrl:`${window.location.origin}/api/altana/relay`,publicRpcUrl:`${window.location.origin}/api/altana/rpc`}]});
  const result=recover ? await client.recoverFromPasskey({chainId:97}) : await client.createPasskeyWallet({name:'Agora Mesh'});
  if(result.signer.credential.kind!=='webauthn') throw new Error('A device Passkey is required.');
  const wallet:PasskeyWallet={version:1,address:result.address,credential:result.signer.credential};
  localStorage.setItem(passkeyWalletStorage,JSON.stringify(wallet));
  window.dispatchEvent(new Event(passkeyWalletEvent));
  return wallet;
}
