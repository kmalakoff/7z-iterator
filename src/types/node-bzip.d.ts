declare module 'seek-bzip' {
  interface Bunzip {
    /**
     * Decode bzip2 compressed data
     * @param input - BZip2 compressed buffer (must start with BZh header)
     * @param output - Optional output buffer
     * @returns Decompressed buffer
     */
    decode(input: Buffer, output?: Buffer): Buffer;
  }
  const Bunzip: Bunzip;
  export = Bunzip;
}
