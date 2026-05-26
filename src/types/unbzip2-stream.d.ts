declare module 'unbzip2-stream/lib/bzip2.js' {
  const bzip2: {
    simple(input: Buffer, pushFn: (byte: number) => void): void;
    header(bitReader: unknown): number;
    decompress(bitReader: unknown, pushFn: (byte: number) => void, buf: Int32Array, bufsize: number, streamCRC: number | null): number | null;
  };
  export = bzip2;
}
