// Bind the local provider's quote to Raydium CLMM's native exact-output
// instructions and actual on-chain pools. Only the inspected wallet accounts
// and chosen quote caps may be used by the transaction we co-sign.
import { PublicKey, SystemProgram, type AccountInfo, type TransactionInstruction } from "@solana/web3.js";
import { ASSOCIATED_TOKEN_PROGRAM, ataFor, TOKEN_2022_PROGRAM } from "./currencies.ts";
import { withConnection } from "./rpcpool.ts";
import { classicAta, discriminator, matches, MEMO_PROGRAM, TOKEN_PROGRAM, USDC, validateWrappedSolCap, WRAPPED_SOL } from "./stock-swap-accounts.ts";

export const RAYDIUM_CLMM = new PublicKey("CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK");
const POOL_STATE = discriminator("account:PoolState");
const TICK_ARRAY = discriminator("account:TickArrayState");
const TICK_BITMAP = discriminator("account:TickArrayBitmapExtension");
const SWAP_V2 = discriminator("global:swap_v2");

function readLeg(account: AccountInfo<Buffer> | null, input: PublicKey, output: PublicKey) {
  if (!account?.owner.equals(RAYDIUM_CLMM) || account.data.length < 233 ||
      !account.data.subarray(0, 8).equals(POOL_STATE)) {
    throw new Error("An approved Raydium pool is unavailable.");
  }
  const [amm, mint0, mint1, vault0, vault1, observation] = [9, 73, 105, 137, 169, 201]
    .map(offset => new PublicKey(account.data.subarray(offset, offset + 32)));
  if (mint0.equals(input) && mint1.equals(output))
    return { amm, inputVault: vault0, outputVault: vault1, observation };
  if (mint1.equals(input) && mint0.equals(output))
    return { amm, inputVault: vault1, outputVault: vault0, observation };
  throw new Error("An approved Raydium pool does not match the requested token pair.");
}

function checkExtraAccount(account: AccountInfo<Buffer> | null, address: PublicKey, pool: PublicKey, bitmap: PublicKey) {
  const expected = address.equals(bitmap) ? TICK_BITMAP : TICK_ARRAY;
  if (!account?.owner.equals(RAYDIUM_CLMM) || account.data.length < 40 ||
      !account.data.subarray(0, 8).equals(expected) || !account.data.subarray(8, 40).equals(pool.toBuffer())) {
    throw new Error("Raydium requested a tick array outside the approved pool.");
  }
}

export async function validateRaydiumRoute(
  setup: TransactionInstruction[],
  swaps: TransactionInstruction[],
  cleanup: TransactionInstruction,
  buyer: PublicKey,
  mint: PublicKey,
  pools: PublicKey[],
  shortfall: bigint,
  limit: bigint,
  intermediate?: bigint,
) {
  const twoLeg = pools.length === 2;
  if ((pools.length !== 1 && !twoLeg) || swaps.length !== pools.length || (twoLeg && !intermediate) ||
      swaps.some(swap => swap.keys.length < 14 || swap.keys.length > 21)) {
    throw new Error("Unsupported Raydium route length or intermediate amount.");
  }
  const wrapped = classicAta(buyer, WRAPPED_SOL);
  const mid = classicAta(buyer, USDC);
  const output = ataFor(buyer, mint);
  const extras = swaps.flatMap(swap => swap.keys.slice(13).map(key => key.pubkey));
  const accounts = await withConnection(rpc =>
    rpc.getMultipleAccountsInfo([wrapped, ...pools, ...extras], "confirmed"));
  if (accounts[0]) throw new Error("The rehearsal requires a fresh wrapped SOL account.");
  const extraSetup = setup.slice(3);
  validateWrappedSolCap(setup.slice(0, 3), cleanup, buyer, wrapped, limit);
  if (extraSetup.length > (twoLeg ? 1 : 0) || extraSetup.some(ix =>
    !matches(ix, ASSOCIATED_TOKEN_PROGRAM, [buyer, mid, buyer, USDC, SystemProgram.programId, TOKEN_PROGRAM]) ||
    ix.data.length !== 1 || ix.data[0] !== 1 || !ix.keys[0].isSigner || !ix.keys[1].isWritable)) {
    throw new Error("Raydium requested unexpected intermediate token account setup.");
  }

  const legs = twoLeg ? [
    { inputMint: WRAPPED_SOL, outputMint: USDC, inputAccount: wrapped, outputAccount: mid, amount: intermediate!, cap: limit },
    { inputMint: USDC, outputMint: mint, inputAccount: mid, outputAccount: output, amount: shortfall, cap: intermediate! },
  ] : [
    { inputMint: WRAPPED_SOL, outputMint: mint, inputAccount: wrapped, outputAccount: output, amount: shortfall, cap: limit },
  ];
  let offset = 1 + pools.length;
  for (const [index, leg] of legs.entries()) {
    const swap = swaps[index], pool = pools[index];
    const state = readLeg(accounts[index + 1], leg.inputMint, leg.outputMint);
    const expected = [
      buyer, state.amm, pool, leg.inputAccount, leg.outputAccount, state.inputVault, state.outputVault,
      state.observation, TOKEN_PROGRAM, TOKEN_2022_PROGRAM, MEMO_PROGRAM, leg.inputMint, leg.outputMint,
    ];
    if (!swap.programId.equals(RAYDIUM_CLMM) || swap.keys.length <= expected.length ||
        !expected.every((address, i) => address.equals(swap.keys[i].pubkey)) ||
        !swap.keys[0].isSigner || !swap.keys[3].isWritable || !swap.keys[4].isWritable ||
        swap.data.length !== 41 || !swap.data.subarray(0, 8).equals(SWAP_V2) ||
        swap.data.readBigUInt64LE(8) !== leg.amount || swap.data.readBigUInt64LE(16) !== leg.cap ||
        swap.data.subarray(24).some(Boolean)) {
      throw new Error("The Raydium swap does not match the reviewed exact output and input cap.");
    }
    const bitmap = PublicKey.findProgramAddressSync(
      [Buffer.from("pool_tick_array_bitmap_extension"), pool.toBuffer()], RAYDIUM_CLMM,
    )[0];
    const tickKeys = swap.keys.slice(expected.length);
    if (tickKeys.every(key => key.pubkey.equals(bitmap))) {
      throw new Error("Unsupported Raydium tick array accounts.");
    }
    for (const key of tickKeys) checkExtraAccount(accounts[offset++], key.pubkey, pool, bitmap);
  }
}
