# 7z-iterator Test Matrix

## Feature Coverage Matrix

| Feature | Phase | Current Fixture | Status | Notes |
|---------|-------|-----------------|--------|-------|
| **Compression Methods** | | | | |
| Copy (uncompressed) | 1 | `copy.7z` ✓ | ✅ Tested | Small, in repo |
| LZMA | 2 | - | ❌ Missing | Need fixture |
| LZMA2 | 2 | `lzma2.7z` ✓ | 🔄 Created | Needs codec impl |
| Deflate | 3+ | - | ❌ Missing | Low priority |
| BZip2 | 3+ | - | ❌ Missing | Low priority |
| PPMd | 3+ | - | ❌ Missing | Low priority |
| **Filters (BCJ)** | | | | |
| BCJ x86 | 3 | - | ❌ Missing | Common with LZMA2 |
| BCJ2 | 3 | - | ❌ Missing | More complex |
| BCJ ARM/ARMT | 3+ | - | ❌ Missing | Architecture specific |
| BCJ PPC/SPARC/IA64 | 3+ | - | ❌ Missing | Architecture specific |
| Delta | 3+ | - | ❌ Missing | Audio/delta encoding |
| **Archive Features** | | | | |
| Non-solid archive | 1 | `copy.7z` ✓ | ✅ Tested | |
| Solid archive | 2 | `lzma2.7z` ✓ | 🔄 Created | Needs codec impl |
| Empty archive | 1 | - | ❌ Missing | Edge case |
| Directories only | 1 | - | ❌ Missing | Edge case |
| Deep nesting | 1 | `copy.7z` ✓ | ✅ Tested | 3 levels |
| Unicode filenames | 2 | - | ❌ Missing | Important |
| Long paths | 2 | - | ❌ Missing | Edge case |
| Symlinks | 3 | - | ❌ Missing | Platform specific |
| **Security** | | | | |
| AES-256 encryption | ❌ | - | Not planned | Out of scope |
| Encrypted filenames | ❌ | - | Not planned | Out of scope |
| **Error Handling** | | | | |
| CRC mismatch | 1 | - | ❌ Missing | Need corrupted file |
| Truncated archive | 1 | - | ❌ Missing | Edge case |
| Invalid signature | 1 | - | ❌ Missing | Edge case |
| **Input Sources** | | | | |
| File path | 1 | `copy.7z` ✓ | ✅ Tested | |
| Stream input | 1 | `copy.7z` ✓ | ✅ Tested | |
| Buffer input | 2 | - | ❌ Missing | |

## Fixture Strategy

### Small Fixtures (< 10KB) - Commit to Git Repo

| Fixture | Size | Codec | Features | Status |
|---------|------|-------|----------|--------|
| `copy.7z` | 562B | Copy | Non-solid, dirs, files | ✅ Exists |
| `lzma2.7z` | 262B | LZMA2 | Solid | ✅ Exists |
| `empty.7z` | 90B | Copy | Empty archive (1 dir) | ✅ Created |
| `unicode.7z` | 370B | Copy | Unicode filenames (日本語/中文) | ✅ Created |
| `corrupted-crc.7z` | 562B | Copy | CRC mismatch in data | ✅ Created |
| `truncated.7z` | 100B | Copy | Truncated (incomplete) | ✅ Created |
| `lzma.7z` | ~300B | LZMA | Non-solid, LZMA only | ❌ Phase 2 |

### External Fixtures (> 10KB or complex) - Download on Test

| Source | URL | Features | Notes |
|--------|-----|----------|-------|
| py7zr test data | `github.com/miurahr/py7zr/tests/data/` | All codecs, filters | MIT license |
| - `lzma2bcj.7z` | | LZMA2 + BCJ x86 | ~1KB |
| - `lzma2bcj2.7z` | | LZMA2 + BCJ2 | ~2KB |
| - `symlink.7z` | | Symlinks | Platform test |
| - `solid.7z` | | Solid archive | Regression |

## Recommended Actions

### Phase 1 (Current) - Copy Codec
1. ✅ `copy.7z` - basic extraction working
2. ✅ `empty.7z` - empty archive edge case
3. ✅ `corrupted-crc.7z` - CRC validation test
4. ✅ `truncated.7z` - truncation handling
5. ✅ `unicode.7z` - Unicode filename support
6. ❌ Add tests for empty/unicode/corrupted/truncated fixtures

### Phase 2 - LZMA/LZMA2 Codec
1. ❌ Create `lzma.7z` - single file, LZMA only
2. ✅ `lzma2.7z` - exists, needs codec implementation
3. ❌ Implement LZMA2 codec via lzma-purejs

### Phase 3 - BCJ Filters & Solid Archives
1. ❌ Download py7zr `lzma2bcj.7z` for BCJ x86 test
2. ❌ Download py7zr `lzma2bcj2.7z` for BCJ2 test
3. ❌ Test solid archive extraction

## External Test Data Sources

### py7zr (MIT License)
- URL: https://github.com/miurahr/py7zr/tree/master/tests/data
- Contains comprehensive test fixtures for all 7z features
- Can download specific files as needed for testing

### Commands to Create Missing Fixtures

```bash
# Empty archive
7z a -m0=Copy empty.7z -x!*

# LZMA only (non-solid)
7z a -m0=LZMA -ms=off lzma.7z data/

# Unicode filenames
mkdir -p data_unicode/日本語/中文
echo "test" > "data_unicode/日本語/テスト.txt"
echo "test" > "data_unicode/中文/测试.txt"
7z a -m0=Copy unicode.7z data_unicode/

# Corrupted CRC (manually edit hex after creation)
cp copy.7z corrupted-crc.7z
# Edit last 4 bytes of file data to corrupt CRC

# Truncated archive
head -c 100 copy.7z > truncated.7z
```

## References

- [py7zr GitHub](https://github.com/miurahr/py7zr/) - Python 7z library with extensive test data
- [7-Zip-zstd](https://github.com/mcmilk/7-Zip-zstd) - Extended 7-Zip with additional codecs
- [7z2hashcat](https://github.com/philsmd/7z2hashcat) - 7z format analysis and filter documentation
