// Validate local, explicitly approved Orca routes. Account order and Borsh
// layouts follow the Whirlpool SwapV2 and TwoHopSwapV2 instructions.
import { PublicKey, type AccountInfo, type TransactionInstruction } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM, ataFor } from "./currencies.ts";
import { withConnection } from "./rpcpool.ts";
import { classicAta, discriminator, matches, MEMO_PROGRAM, TOKEN_PROGRAM, USDC, validateWrappedSolCap, WRAPPED_SOL } from "./stock-swap-accounts.ts";

export const ORCA_ROUTER = new PublicKey("whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc");
const POOL_DISCRIMINATOR = discriminator("account:Whirlpool");
const SWAP_V2_DISCRIMINATOR = discriminator("global:swap_v2");
const TWO_HOP_V2_DISCRIMINATOR = discriminator("global:two_hop_swap_v2");

function readLeg(address: PublicKey, pool: AccountInfo<Buffer> | null, input: PublicKey, output: PublicKey) {
  if (!pool?.owner.equals(ORCA_ROUTER) || pool.data.length !== 653 ||
      !pool.data.subarray(0, 8).equals(POOL_DISCRIMINATOR)) {
    throw new Error("An approved Orca pool is unavailable.");
  }
  const mintA = new PublicKey(pool.data.subarray(101, 133));
  const vaultA = new PublicKey(pool.data.subarray(133, 165));
  const mintB = new PublicKey(pool.data.subarray(181, 213));
  const vaultB = new PublicKey(pool.data.subarray(213, 245));
  const aToB = mintA.equals(input) && mintB.equals(output);
  if (!aToB && !(mintB.equals(input) && mintA.equals(output))) {
    throw new Error("An approved Orca pool does not match the requested token pair.");
  }
  const [oracle] = PublicKey.findProgramAddressSync([Buffer.from("oracle"), address.toBuffer()], ORCA_ROUTER);
  return { mintA, mintB, vaultA, vaultB, aToB, oracle,
    inputVault: aToB ? vaultA : vaultB, outputVault: aToB ? vaultB : vaultA };
}

function bindsExactOutput(data: Buffer, shortfall: bigint, limit: bigint) {
  return data.readBigUInt64LE(8) === shortfall && data.readBigUInt64LE(16) === limit;
}

export async function validateOrcaRoute(
  setup: TransactionInstruction[],
  swap: TransactionInstruction,
  cleanup: TransactionInstruction,
  buyer: PublicKey,
  mint: PublicKey,
  pools: PublicKey[],
  shortfall: bigint,
  limit: bigint,
) {
  if (pools.length !== 1 && pools.length !== 2) throw new Error("Unsupported Orca route length.");
  // Non-idempotent creation stops the whole transaction if wrapped SOL
  // appears after the quote was prepared.
  const wrapped = classicAta(buyer, WRAPPED_SOL);
  const accounts = await withConnection(rpc =>
    rpc.getMultipleAccountsInfo([...pools, wrapped], "confirmed"));
  if (accounts.at(-1)) throw new Error("The rehearsal requires a fresh wrapped SOL account.");

  validateWrappedSolCap(setup, cleanup, buyer, wrapped, limit);

  const output = ataFor(buyer, mint);
  const { data, keys } = swap;
  const first = readLeg(pools[0], accounts[0], WRAPPED_SOL, pools.length === 1 ? mint : USDC);
  if (pools.length === 1) {
    const ordered = [
      first.aToB ? TOKEN_PROGRAM : TOKEN_2022_PROGRAM, first.aToB ? TOKEN_2022_PROGRAM : TOKEN_PROGRAM,
      MEMO_PROGRAM, buyer, pools[0], first.mintA, first.mintB, first.aToB ? wrapped : output, first.vaultA,
      first.aToB ? output : wrapped, first.vaultB, null, null, null, first.oracle,
    ];
    if (!matches(swap, ORCA_ROUTER, ordered) || !keys[3].isSigner ||
        !keys[7].isWritable || !keys[9].isWritable ||
        data.length !== 43 || !data.subarray(0, 8).equals(SWAP_V2_DISCRIMINATOR) ||
        !bindsExactOutput(data, shortfall, limit) || data.subarray(24, 41).some(Boolean) ||
        data[41] !== Number(first.aToB) || data[42] !== 0) {
      throw new Error("The Orca swap does not match the reviewed exact output and SOL cap.");
    }
    return;
  }

  const second = readLeg(pools[1], accounts[1], USDC, mint);
  const ordered = [
    pools[0], pools[1], WRAPPED_SOL, USDC, mint, TOKEN_PROGRAM, TOKEN_PROGRAM, TOKEN_2022_PROGRAM,
    wrapped, first.inputVault, first.outputVault, second.inputVault, second.outputVault, output, buyer,
    null, null, null, null, null, null, first.oracle, second.oracle, MEMO_PROGRAM,
  ];
  // USDC moves vault-to-vault. Zero sqrt-price limits preserve exact output
  // or fail the instruction. Remaining account slices are not supported here.
  if (!matches(swap, ORCA_ROUTER, ordered) || !keys[14].isSigner ||
      !keys[8].isWritable || !keys[13].isWritable ||
      data.length !== 60 || !data.subarray(0, 8).equals(TWO_HOP_V2_DISCRIMINATOR) ||
      !bindsExactOutput(data, shortfall, limit) || data[24] !== 0 ||
      data[25] !== Number(first.aToB) || data[26] !== Number(second.aToB) ||
      data.subarray(27, 60).some(Boolean)) {
    throw new Error("The Orca two-pool swap does not match the reviewed exact output and SOL cap.");
  }
}
