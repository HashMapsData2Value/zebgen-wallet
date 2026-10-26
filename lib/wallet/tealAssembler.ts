// A deliberately tiny TEAL v10 assembler: only the opcodes the fee-sponsor program uses, and anything else is rejected.
// Encodings and field ids were read from algod's own compiler and are re-checked against it in scripts/tealAssembler.test.mjs.

const SIMPLE: Record<string, number> = {
  '+': 0x08,
  '*': 0x0b,
  '==': 0x12,
  '!': 0x14,
  return: 0x43,
  assert: 0x44,
  dup: 0x49,
  intc_0: 0x22,
  intc_1: 0x23,
  intc_2: 0x24,
  intc_3: 0x25,
  bytec_0: 0x28,
  bytec_1: 0x29,
};
const UINT8_IMMEDIATE: Record<string, number> = {
  intc: 0x21,
  dig: 0x4b,
  cover: 0x4e,
  uncover: 0x4f,
};
const BRANCH: Record<string, number> = { bnz: 0x40, bz: 0x41, b: 0x42 };
const FIELD_OPCODE: Record<string, [number, Record<string, number>]> = {
  txn: [0x31, { Fee: 1, Receiver: 7, Amount: 8, CloseRemainderTo: 9, GroupIndex: 22, RekeyTo: 32 }],
  global: [0x32, { MinTxnFee: 0, MinBalance: 1, ZeroAddress: 3, GroupSize: 4 }],
  gtxns: [0x38, { TypeEnum: 16, ApplicationID: 24, OnCompletion: 25 }],
  gtxnsas: [0xc2, { ApplicationArgs: 26 }],
};

const MAX_UINT64 = 2n ** 64n - 1n;

function varuint(value: bigint): number[] {
  const out: number[] = [];
  let rest = value;
  while (rest >= 0x80n) {
    out.push(Number(rest & 0x7fn) | 0x80);
    rest >>= 7n;
  }
  out.push(Number(rest));
  return out;
}

function integer(token: string): bigint {
  if (!/^(0|[1-9][0-9]*)$/.test(token)) throw new Error(`Unsupported integer "${token}".`);
  const value = BigInt(token);
  if (value > MAX_UINT64) throw new Error(`Integer "${token}" does not fit in 64 bits.`);
  return value;
}

function bytesLiteral(token: string): number[] {
  if (!/^0x([0-9a-fA-F]{2})*$/.test(token)) throw new Error(`Unsupported byte literal "${token}".`);
  const hex = token.slice(2);
  return Array.from({ length: hex.length / 2 }, (_, index) =>
    parseInt(hex.slice(index * 2, index * 2 + 2), 16),
  );
}

type Item = { bytes: number[] } | { branch: number; label: string };

export function assembleTeal(source: string): Uint8Array {
  let version: number | null = null;
  const items: Item[] = [];
  const labels = new Map<string, number>();
  let position = 0;

  for (const rawLine of source.split('\n')) {
    const line = rawLine.replace(/\/\/.*$/, '').trim();
    if (!line) continue;
    const tokens = line.split(/\s+/);
    const [head, ...args] = tokens;

    if (head === '#pragma') {
      if (args[0] === 'version' && args.length === 2) {
        version = Number(integer(args[1]));
        if (version !== 10) throw new Error('Only TEAL version 10 is supported.');
      } else if (!(args[0] === 'typetrack' && args[1] === 'false' && args.length === 2)) {
        throw new Error(`Unsupported pragma "${line}".`);
      }
      continue;
    }
    if (head.endsWith(':') && args.length === 0) {
      const label = head.slice(0, -1);
      if (!/^[A-Za-z_][A-Za-z0-9_@.]*$/.test(label) || labels.has(label))
        throw new Error(`Bad or duplicate label "${label}".`);
      labels.set(label, position);
      continue;
    }

    let bytes: number[];
    if (head in SIMPLE && args.length === 0) bytes = [SIMPLE[head]];
    else if (head in UINT8_IMMEDIATE && args.length === 1) {
      const value = integer(args[0]);
      if (value > 255n) throw new Error(`Immediate "${args[0]}" does not fit in a byte.`);
      bytes = [UINT8_IMMEDIATE[head], Number(value)];
    } else if (head in FIELD_OPCODE && args.length === 1) {
      const [opcode, fields] = FIELD_OPCODE[head];
      if (!(args[0] in fields)) throw new Error(`Unsupported field "${head} ${args[0]}".`);
      bytes = [opcode, fields[args[0]]];
    } else if (head === 'pushint' && args.length === 1)
      bytes = [0x81, ...varuint(integer(args[0]))];
    else if (head === 'pushbytes' && args.length === 1) {
      const data = bytesLiteral(args[0]);
      bytes = [0x80, ...varuint(BigInt(data.length)), ...data];
    } else if (head === 'intcblock' && args.length > 0) {
      bytes = [
        0x20,
        ...varuint(BigInt(args.length)),
        ...args.flatMap((value) => varuint(integer(value))),
      ];
    } else if (head === 'bytecblock' && args.length > 0) {
      bytes = [
        0x26,
        ...varuint(BigInt(args.length)),
        ...args.flatMap((value) => {
          const data = bytesLiteral(value);
          return [...varuint(BigInt(data.length)), ...data];
        }),
      ];
    } else if (head in BRANCH && args.length === 1) {
      items.push({ branch: BRANCH[head], label: args[0] });
      position += 3;
      continue;
    } else throw new Error(`Unsupported TEAL instruction "${line}".`);

    items.push({ bytes });
    position += bytes.length;
  }
  if (version !== 10) throw new Error('Missing "#pragma version 10".');

  const program: number[] = [version];
  let offset = 1;
  for (const item of items) {
    if ('bytes' in item) {
      program.push(...item.bytes);
      offset += item.bytes.length;
      continue;
    }
    const target = labels.get(item.label);
    if (target === undefined) throw new Error(`Unknown label "${item.label}".`);
    // Branch offsets are relative to the first byte after the 3-byte instruction.
    const relative = target - (offset - 1 + 3);
    if (relative < 0 || relative > 0xffff) throw new Error('Only forward branches are supported.');
    program.push(item.branch, relative >> 8, relative & 0xff);
    offset += 3;
  }
  return Uint8Array.from(program);
}
