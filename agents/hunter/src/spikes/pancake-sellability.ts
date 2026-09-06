import path from "node:path";
import { config as loadDotenv } from "dotenv";
import {
  Contract,
  JsonRpcProvider,
  Wallet,
  formatEther,
  getAddress,
  keccak256
} from "ethers";

loadDotenv({ path: path.resolve(process.env.INIT_CWD ?? process.cwd(), ".env") });

const CONFIRMATION = "I_CONFIRM_0_1_U_SELLABILITY_5_PERCENT";
const CHAIN_ID = 97;
const EXPECTED_WALLET = getAddress("0x8BA5452112F7E9c339da8E6f38C896B2A0B2E53d");
const U_TOKEN = getAddress("0xc70B8741B8B07A6d61E54fd4B20f22Fa648E5565");
const WBNB = getAddress("0xae13d989daC2f0dEbFf460aC112a837C89BAa7cd");
const ROUTER = getAddress("0xD99D1c33F9fC3444f8101754aBC46c52416550D1");
const PAIR = getAddress("0x55ed32b1808d4Bb9aD8DF8201494b74B982915F8");
const AMOUNT_IN = 100_000_000_000_000_000n;
const SLIPPAGE_BPS = 500n;

const erc20Abi = [
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)"
];
const routerAbi = [
  "function WETH() view returns (address)",
  "function getAmountsOut(uint256,address[]) view returns (uint256[])",
  "function swapExactTokensForTokens(uint256,uint256,address[],address,uint256) returns (uint256[])"
];
const pairAbi = [
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function getReserves() view returns (uint112,uint112,uint32)"
];

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function requireSuccessfulReceipt(
  label: string,
  receipt: { status?: number | null; hash: string; blockNumber: number; gasUsed: bigint } | null
) {
  if (!receipt || receipt.status !== 1) {
    throw new Error(`${label} transaction was not confirmed successfully`);
  }
  return receipt;
}

async function main(): Promise<void> {
  if (process.env.SELLABILITY_CONFIRM !== CONFIRMATION) {
    throw new Error(`Refusing to broadcast. Set SELLABILITY_CONFIRM=${CONFIRMATION}`);
  }
  const privateKey = requiredEnv("ALTANA_X402_ADMIN_PRIVATE_KEY");
  if (!/^0x[0-9a-fA-F]{64}$/.test(privateKey)) {
    throw new Error("ALTANA_X402_ADMIN_PRIVATE_KEY must be a 32-byte hex private key");
  }
  const rpcUrl = process.env.SELLABILITY_RPC_URL?.trim() || requiredEnv("RPC_URL");
  const provider = new JsonRpcProvider(rpcUrl, CHAIN_ID, { staticNetwork: true });
  const wallet = new Wallet(privateKey, provider);
  if (wallet.address !== EXPECTED_WALLET) {
    throw new Error(`Configured signer is ${wallet.address}, expected ${EXPECTED_WALLET}`);
  }
  const network = await provider.getNetwork();
  if (Number(network.chainId) !== CHAIN_ID) {
    throw new Error(`Wrong chain: expected ${CHAIN_ID}, got ${network.chainId}`);
  }

  const token = new Contract(U_TOKEN, erc20Abi, wallet);
  const wrapped = new Contract(WBNB, erc20Abi, provider);
  const router = new Contract(ROUTER, routerAbi, wallet);
  const pair = new Contract(PAIR, pairAbi, provider);
  const [
    tokenSymbol,
    tokenDecimals,
    wrappedSymbol,
    wrappedDecimals,
    routerWrapped,
    pairToken0,
    pairToken1,
    reserves,
    routerCode,
    pairCode,
    wrappedCode,
    nativeBefore,
    tokenBefore,
    wrappedBefore,
    allowanceBefore
  ] = await Promise.all([
    token.symbol(),
    token.decimals(),
    wrapped.symbol(),
    wrapped.decimals(),
    router.WETH(),
    pair.token0(),
    pair.token1(),
    pair.getReserves(),
    provider.getCode(ROUTER),
    provider.getCode(PAIR),
    provider.getCode(WBNB),
    provider.getBalance(wallet.address),
    token.balanceOf(wallet.address),
    wrapped.balanceOf(wallet.address),
    token.allowance(wallet.address, ROUTER)
  ]);
  if (tokenSymbol !== "U" || Number(tokenDecimals) !== 18) throw new Error("Unexpected input token metadata");
  if (wrappedSymbol !== "WBNB" || Number(wrappedDecimals) !== 18) throw new Error("Unexpected output token metadata");
  if (getAddress(routerWrapped) !== WBNB) throw new Error("Router WETH/WBNB binding mismatch");
  const pairTokens = new Set([getAddress(pairToken0), getAddress(pairToken1)]);
  if (!pairTokens.has(U_TOKEN) || !pairTokens.has(WBNB)) throw new Error("Pair token binding mismatch");
  if (routerCode === "0x" || pairCode === "0x" || wrappedCode === "0x") throw new Error("Required contract code is missing");
  if (tokenBefore < AMOUNT_IN) throw new Error("Insufficient U balance for sellability test");
  if (allowanceBefore !== 0n) {
    throw new Error(`Expected zero pre-existing Router allowance, got ${allowanceBefore}`);
  }

  const pathTokens = [U_TOKEN, WBNB];
  const quoteBefore = await router.getAmountsOut(AMOUNT_IN, pathTokens) as bigint[];
  const quotedOut = quoteBefore[1];
  if (!quotedOut || quotedOut <= 0n) throw new Error("Router returned a zero quote");
  const minimumOut = quotedOut * (10_000n - SLIPPAGE_BPS) / 10_000n;

  const approvalGas = await token.approve.estimateGas(ROUTER, AMOUNT_IN);
  const approvalTransaction = await token.approve(ROUTER, AMOUNT_IN, {
    gasLimit: approvalGas * 120n / 100n
  });
  const approvalReceipt = requireSuccessfulReceipt(
    "exact Router approval",
    await approvalTransaction.wait(1)
  );

  const allowanceAfterApproval = await token.allowance(wallet.address, ROUTER) as bigint;
  if (allowanceAfterApproval !== AMOUNT_IN) {
    throw new Error(`Exact Router allowance mismatch: ${allowanceAfterApproval}`);
  }
  const liveQuote = await router.getAmountsOut(AMOUNT_IN, pathTokens) as bigint[];
  const liveQuotedOut = liveQuote[1];
  if (!liveQuotedOut || liveQuotedOut < minimumOut) {
    throw new Error(`Live quote ${liveQuotedOut ?? 0n} fell below confirmed minimum ${minimumOut}`);
  }
  const liveMinimumOut = liveQuotedOut * (10_000n - SLIPPAGE_BPS) / 10_000n;
  const deadline = Math.floor(Date.now() / 1000) + 600;
  const swapGas = await router.swapExactTokensForTokens.estimateGas(
    AMOUNT_IN,
    liveMinimumOut,
    pathTokens,
    wallet.address,
    deadline
  );
  const swapTransaction = await router.swapExactTokensForTokens(
    AMOUNT_IN,
    liveMinimumOut,
    pathTokens,
    wallet.address,
    deadline,
    { gasLimit: swapGas * 120n / 100n }
  );
  const swapReceipt = requireSuccessfulReceipt("sellability swap", await swapTransaction.wait(1));

  const [nativeAfter, tokenAfter, wrappedAfter, allowanceAfter] = await Promise.all([
    provider.getBalance(wallet.address),
    token.balanceOf(wallet.address) as Promise<bigint>,
    wrapped.balanceOf(wallet.address) as Promise<bigint>,
    token.allowance(wallet.address, ROUTER) as Promise<bigint>
  ]);
  const tokenSpent = tokenBefore - tokenAfter;
  const wrappedReceived = wrappedAfter - wrappedBefore;
  if (tokenSpent !== AMOUNT_IN) throw new Error(`Unexpected U balance delta: ${tokenSpent}`);
  if (wrappedReceived < liveMinimumOut) throw new Error(`WBNB received ${wrappedReceived} below minimum ${liveMinimumOut}`);
  if (allowanceAfter !== 0n) throw new Error(`Router allowance was not fully consumed: ${allowanceAfter}`);

  process.stdout.write(`${JSON.stringify({
    version: 1,
    evidenceKind: "executed-sellability-test",
    status: "confirmed",
    observedAt: new Date().toISOString(),
    chainId: CHAIN_ID,
    wallet: wallet.address,
    input: { symbol: "U", address: U_TOKEN, decimals: 18, amountRaw: AMOUNT_IN.toString() },
    output: { symbol: "WBNB", address: WBNB, decimals: 18, amountRaw: wrappedReceived.toString() },
    route: {
      venue: "PancakeSwap V2",
      router: ROUTER,
      pair: PAIR,
      path: pathTokens,
      routerCodeHash: keccak256(routerCode),
      pairCodeHash: keccak256(pairCode),
      wrappedCodeHash: keccak256(wrappedCode),
      reserve0BeforeRaw: reserves[0].toString(),
      reserve1BeforeRaw: reserves[1].toString()
    },
    protection: {
      slippageBps: Number(SLIPPAGE_BPS),
      initialQuoteOutRaw: quotedOut.toString(),
      liveQuoteOutRaw: liveQuotedOut.toString(),
      minimumOutRaw: liveMinimumOut.toString(),
      deadline
    },
    balances: {
      nativeBeforeRaw: nativeBefore.toString(),
      nativeAfterRaw: nativeAfter.toString(),
      inputBeforeRaw: tokenBefore.toString(),
      inputAfterRaw: tokenAfter.toString(),
      outputBeforeRaw: wrappedBefore.toString(),
      outputAfterRaw: wrappedAfter.toString(),
      routerAllowanceBeforeRaw: allowanceBefore.toString(),
      routerAllowanceAfterApprovalRaw: allowanceAfterApproval.toString(),
      routerAllowanceAfterSwapRaw: allowanceAfter.toString()
    },
    transactions: {
      exactApproval: {
        hash: approvalReceipt.hash,
        blockNumber: approvalReceipt.blockNumber,
        gasUsed: approvalReceipt.gasUsed.toString()
      },
      swap: {
        hash: swapReceipt.hash,
        blockNumber: swapReceipt.blockNumber,
        gasUsed: swapReceipt.gasUsed.toString()
      }
    },
    interpretation: "The wallet sold exactly 0.1 U for WBNB through the bound PancakeSwap V2 pair; the output met the 5% minimum and the exact Router allowance was fully consumed."
  }, null, 2)}\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`Sellability test failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
