import fs from 'fs';

function getFdDir(): string | null {
  if (fs.existsSync('/dev/fd')) return '/dev/fd';
  if (fs.existsSync('/proc/self/fd')) return '/proc/self/fd';
  return null;
}

export const FD_DIR = getFdDir();

// Count open fds in this process referencing the given (dev, ino)
export function countOpenFdsForInode(dev: number, ino: number): number {
  if (!FD_DIR) return 0;
  let names: string[];
  try {
    names = fs.readdirSync(FD_DIR);
  } catch (_e) {
    return 0;
  }
  let count = 0;
  for (let i = 0; i < names.length; i++) {
    if (!/^\d+$/.test(names[i])) continue;
    const fd = parseInt(names[i], 10);
    if (fd < 3) continue;
    try {
      const st = fs.fstatSync(fd);
      if (st.dev === dev && st.ino === ino) count++;
    } catch (_e) {
      // Closed between readdir and fstat (such as readdir's own directory fd)
    }
  }
  return count;
}
