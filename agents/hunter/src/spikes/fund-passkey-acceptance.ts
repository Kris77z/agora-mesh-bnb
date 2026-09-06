import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createPublicClient, createWalletClient, custom, encodeFunctionData, erc20Abi, keccak256, parseEther } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { bscTestnet } from 'viem/chains';
import { hunterConfig } from '../config.js';

// Fixed destination supplied by the owner for the first browser acceptance.
const destination = '0xc7B8c226fFdac9b5218ab570bc6c1d443275d28c' as const;
const source = '0x8BA5452112F7E9c339da8E6f38C896B2A0B2E53d';
const token = '0xc70B8741B8B07A6d61E54fd4B20f22Fa648E5565' as const;
const evidencePath = resolve(process.cwd(), '../../evidence/PASSKEY_FUNDING_20260906.json');
const transport = custom({request: async ({method, params}) => {
  // curl uses the host's working TLS/network path. Never print RPC payloads.
  const result = await new Promise<string>((resolveResult, reject) => {
    const args = ['-sS', '--max-time', '20'];
    if (!method.startsWith('eth_send')) args.push('--retry', '2', '--retry-all-errors');
    args.push('https://bsc-testnet-rpc.publicnode.com', '-H', 'Content-Type: application/json', '--data-binary', '@-');
    const child = spawn('curl', args, {stdio: ['pipe', 'pipe', 'pipe']});
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.resume();
    child.on('error', () => reject(new Error('RPC transport unavailable')));
    child.on('close', (code) => code === 0 ? resolveResult(output) : reject(new Error('RPC transport failed')));
    child.stdin.end(JSON.stringify({jsonrpc: '2.0', id: 1, method, params}));
  });
  const response = JSON.parse(result);
  if (response.error) throw new Error(`RPC rejected ${method}, code ${response.error.code}`);
  return response.result;
}}, {retryCount: 0});

async function main() {
  const rpc = createPublicClient({chain: bscTestnet, transport});
  if (hunterConfig.chainId !== 97 || await rpc.getChainId() !== 97) throw new Error('Requires BNB testnet');
  const key = process.env.ALTANA_X402_ADMIN_PRIVATE_KEY;
  if (!key || !/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error('Funding key unavailable');
  const account = privateKeyToAccount(key as `0x${string}`);
  if (account.address.toLowerCase() !== source.toLowerCase()) throw new Error('Unexpected funding account');
  const wallet = createWalletClient({account, chain: bscTestnet, transport});
  const journal = existsSync(evidencePath) ? JSON.parse(readFileSync(evidencePath, 'utf8')) : {
    chainId: 97, destination, source, token, createdAt: new Date().toISOString(), transactions: []
  };
  if (journal.destination !== destination || journal.chainId !== 97) throw new Error('Evidence mismatch');
  const save = () => writeFileSync(evidencePath, JSON.stringify(journal, null, 2) + '\n');
  // Reconcile prior signed transactions before preparing any additional transfer.
  for (const previous of journal.transactions) {
    const receipt = await rpc.getTransactionReceipt({hash: previous.hash});
    if (receipt.status !== 'success') throw new Error('Prior funding transaction failed');
    previous.status = 'confirmed';
  }
  for (const asset of ['tBNB', 'U'] as const) {
    if (journal.transactions.some((entry: {asset: string; status: string}) => entry.asset === asset && entry.status === 'confirmed')) continue;
    const target = parseEther(asset === 'tBNB' ? '0.003' : '1.15');
    const balance = asset === 'tBNB' ? await rpc.getBalance({address: destination}) : await rpc.readContract({address: token, abi: erc20Abi, functionName: 'balanceOf', args: [destination]});
    if (balance >= target) continue;
    const amount = target - balance;
    if (asset === 'U' && await rpc.readContract({address: token, abi: erc20Abi, functionName: 'balanceOf', args: [account.address]}) < amount) throw new Error('Insufficient funding U');
    const request = await wallet.prepareTransactionRequest({
      to: asset === 'tBNB' ? destination : token,
      value: asset === 'tBNB' ? amount : 0n,
      data: asset === 'U' ? encodeFunctionData({abi: erc20Abi, functionName: 'transfer', args: [destination, amount]}) : undefined,
    });
    const serialized = await wallet.signTransaction(request);
    const hash = keccak256(serialized);
    const record = {asset, amountWei: amount.toString(), beforeWei: balance.toString(), hash, status: 'signed'};
    journal.transactions.push(record);
    save(); // Known hash persisted before broadcast; uncertain sends cannot duplicate.
    await rpc.sendRawTransaction({serializedTransaction: serialized});
    const receipt = await rpc.waitForTransactionReceipt({hash, timeout: 90_000});
    if (receipt.status !== 'success') throw new Error('Funding transaction reverted');
    record.status = 'confirmed';
    save();
    console.log(JSON.stringify(record));
  }
  journal.finalBalances = {
    nativeWei: (await rpc.getBalance({address: destination})).toString(),
    tokenWei: (await rpc.readContract({address: token, abi: erc20Abi, functionName: 'balanceOf', args: [destination]})).toString(),
    checkedAt: new Date().toISOString()
  };
  save();
  console.log(JSON.stringify(journal.finalBalances));
}
main().catch(() => { console.error('Funding stopped; inspect the public transaction journal before retrying. RPC/key payloads suppressed.'); process.exitCode = 1; });
