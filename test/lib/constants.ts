import path from 'path';
import url from 'url';

const __dirname = path.dirname(typeof __filename !== 'undefined' ? __filename : url.fileURLToPath(import.meta.url));
export const TMP_DIR = path.join(path.join(__dirname, '..', '..', '.tmp'));
export const TARGET = path.join(path.join(TMP_DIR, 'target'));
export const DATA_DIR = path.join(path.join(__dirname, '..', 'data'));
export const FIXTURE_CONTENT = '// Test fixture file'; // Content prefix in test files
