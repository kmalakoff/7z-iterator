# Future Enhancements

## PPMd Codec Support

**Status**: Not implemented
**Priority**: Low (rarely used in practice)

### Background

PPMd (Prediction by Partial Matching, variant D) is an alternative compression
method in 7-Zip, primarily used for text files. LZMA2 is the default and covers
99%+ of real-world 7z archives.

### Implementation Complexity

PPMd7 requires porting ~800-1000 lines of C code from 7-Zip:
- `Ppmd7.c` - Model building and memory management
- `Ppmd7Dec.c` - Range decoder and symbol decoding

Key challenges:
- Dynamic context tree construction via `CreateSuccessors()`
- Complex memory allocator (HiUnit/LoUnit/FreeList)
- SEE (Secondary Escape Estimation) tables
- Proper suffix chain management

### Resources

- 7-Zip source: https://github.com/jljusten/LZMA-SDK/tree/master/C
- PPMd algorithm paper by Dmitry Shkarin
