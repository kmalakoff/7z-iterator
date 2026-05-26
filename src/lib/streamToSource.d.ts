import { FileSource } from '../sevenz/SevenZipParser.ts';
export interface StreamToSourceOptions {
  tempPath: string;
}
export interface SourceResult {
  source: FileSource;
  fd: number;
  tempPath: string;
}
export type Callback = (error?: Error, result?: SourceResult) => void;
/**
 * Convert a stream to a FileSource by writing to temp file
 *
 * 7z format requires random access for header parsing, so temp file is necessary for streams.
 * Writes directly to temp file for predictable O(1) memory usage during stream consumption.
 */
export default function streamToSource(stream: NodeJS.ReadableStream, options: StreamToSourceOptions, callback: Callback): void;
