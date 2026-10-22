package workspace

import (
	"archive/tar"
	"archive/zip"
	"bufio"
	"bytes"
	"compress/gzip"
	"errors"
	"fmt"
	"io"
	"io/fs"
)

// Archive formats accepted by extract: the tar.gz the API specifies, and zip.
var (
	gzipMagic = []byte{0x1f, 0x8b}
	zipMagics = [][]byte{[]byte("PK\x03\x04"), []byte("PK\x05\x06")}
)

// archiveKind classifies an archive entry. Only files and directories can be extracted.
type archiveKind int

const (
	archiveFile archiveKind = iota
	archiveDir
	archiveSymlink
	archiveHardlink
	archiveDevice
	archiveFIFO
	archiveOther
)

func (k archiveKind) String() string {
	switch k {
	case archiveFile:
		return "regular file"
	case archiveDir:
		return "directory"
	case archiveSymlink:
		return "symlink"
	case archiveHardlink:
		return "hardlink"
	case archiveDevice:
		return "device"
	case archiveFIFO:
		return "FIFO"
	default:
		return "unsupported entry"
	}
}

// archiveEntry is one entry of an upload archive.
type archiveEntry struct {
	name string
	kind archiveKind
	// mode holds the permission bits of the entry.
	mode fs.FileMode
	// size is the declared size of a file (-1 when unknown); extraction counts the actual bytes.
	size int64
	open func() (io.ReadCloser, error)
}

// archiveReader iterates the entries of an archive; Next returns io.EOF at the end.
type archiveReader interface {
	Next() (*archiveEntry, error)
}

// errArchiveTooLarge marks reads beyond the compressed cap.
var errArchiveTooLarge = errors.New("archive too large")

// limitedReader fails with errArchiveTooLarge once more than limit bytes were read (limit 0: no limit).
type limitedReader struct {
	r     io.Reader
	n     int64
	limit int64
}

func (l *limitedReader) Read(p []byte) (int, error) {
	n, err := l.r.Read(p)
	l.n += int64(n)
	if l.limit > 0 && l.n > l.limit {
		return n, errArchiveTooLarge
	}
	return n, err
}

// openArchive detects the archive format (gzip-compressed tar or zip) from its first bytes. Compressed
// bytes are counted while streaming and capped at maxPackBytes. A zip archive needs random access and
// is read into memory, which the cap bounds.
func openArchive(r io.Reader, maxPackBytes int64) (archiveReader, error) {
	counted := &limitedReader{r: r, limit: maxPackBytes}
	br := bufio.NewReader(counted)
	head, err := br.Peek(4)
	if err != nil && !errors.Is(err, io.EOF) {
		return nil, archiveError(err, maxPackBytes)
	}
	switch {
	case bytes.HasPrefix(head, gzipMagic):
		gz, err := gzip.NewReader(br)
		if err != nil {
			return nil, archiveError(err, maxPackBytes)
		}
		return &tarArchive{tr: tar.NewReader(gz)}, nil
	case len(head) == 4 && (bytes.Equal(head, zipMagics[0]) || bytes.Equal(head, zipMagics[1])):
		data, err := io.ReadAll(br)
		if err != nil {
			return nil, archiveError(err, maxPackBytes)
		}
		zr, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
		// Insecure names (GODEBUG zipinsecurepath=0) are reported by the path rules with the offending
		// path, like every other archive.
		if err != nil && !errors.Is(err, zip.ErrInsecurePath) {
			return nil, invalidArgument("invalid zip archive: %v", err)
		}
		return &zipArchive{files: zr.File}, nil
	case len(head) == 0:
		return nil, invalidArgument("the archive is empty")
	default:
		return nil, invalidArgument("the upload is neither a gzip-compressed tar nor a zip archive")
	}
}

// archiveError maps a read error of the archive stream: the compressed cap, or a malformed archive.
func archiveError(err error, maxPackBytes int64) error {
	if errors.Is(err, errArchiveTooLarge) {
		return limitError(CodeTooLarge, maxPackBytes, -1, "the archive is larger than %d bytes", maxPackBytes)
	}
	var werr *Error
	if errors.As(err, &werr) {
		return werr
	}
	return invalidArgument("invalid archive: %v", err)
}

type tarArchive struct {
	tr *tar.Reader
}

func (a *tarArchive) Next() (*archiveEntry, error) {
	for {
		hdr, err := a.tr.Next()
		// Insecure names (GODEBUG tarinsecurepath=0) are reported by the path rules with the offending
		// path, like every other archive.
		if err != nil && !errors.Is(err, tar.ErrInsecurePath) {
			return nil, err
		}
		if hdr.Typeflag == tar.TypeXGlobalHeader {
			// GitHub tarballs start with a global PAX header carrying the commit id.
			continue
		}
		e := &archiveEntry{name: hdr.Name, mode: fs.FileMode(hdr.Mode & 0o777), size: -1} //nolint:gosec // masked to the permission bits
		switch hdr.Typeflag {
		case tar.TypeReg:
			e.kind, e.size = archiveFile, hdr.Size
			e.open = func() (io.ReadCloser, error) { return io.NopCloser(a.tr), nil }
		case tar.TypeDir:
			e.kind = archiveDir
		case tar.TypeSymlink:
			e.kind = archiveSymlink
		case tar.TypeLink:
			e.kind = archiveHardlink
		case tar.TypeChar, tar.TypeBlock:
			e.kind = archiveDevice
		case tar.TypeFifo:
			e.kind = archiveFIFO
		default:
			e.kind = archiveOther
		}
		return e, nil
	}
}

type zipArchive struct {
	files []*zip.File
	next  int
}

func (a *zipArchive) Next() (*archiveEntry, error) {
	if a.next >= len(a.files) {
		return nil, io.EOF
	}
	f := a.files[a.next]
	a.next++
	if f.Flags&0x1 != 0 {
		return nil, invalidArgument("encrypted zip entries are not supported (%q)", printable(f.Name))
	}
	mode := f.Mode()
	e := &archiveEntry{name: f.Name, mode: mode.Perm(), size: -1}
	switch {
	case mode&fs.ModeSymlink != 0:
		e.kind = archiveSymlink
	case mode&(fs.ModeDevice|fs.ModeCharDevice) != 0:
		e.kind = archiveDevice
	case mode&fs.ModeNamedPipe != 0:
		e.kind = archiveFIFO
	case mode&(fs.ModeSocket|fs.ModeIrregular) != 0:
		e.kind = archiveOther
	case mode.IsDir() || len(f.Name) > 0 && f.Name[len(f.Name)-1] == '/':
		e.kind = archiveDir
	default:
		e.kind = archiveFile
		if f.UncompressedSize64 <= 1<<62 {
			e.size = int64(f.UncompressedSize64)
		}
		e.open = func() (io.ReadCloser, error) {
			rc, err := f.Open()
			if err != nil {
				return nil, fmt.Errorf("open %s: %w", f.Name, err)
			}
			return rc, nil
		}
	}
	return e, nil
}
