package taskpipe

import (
	"archive/tar"
	"compress/gzip"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"
)

// ReadPack reads a tar.gz pack (the output of `scantor task pack` or a workspace snapshot), applies the
// same entry rules, .dockerignore and hard excludes as PackDir and re-writes it canonically, so the
// pack hash is the one PackDir computes for the same files. The caps apply to the input as it streams.
// Content problems are returned as PackErrors.
func ReadPack(ctx context.Context, r io.Reader, limits PackLimits) (*Pack, error) {
	spool, err := os.CreateTemp(limits.TempDir, "scantor-pack-input-*")
	if err != nil {
		return nil, fmt.Errorf("create pack input spool: %w", err)
	}
	defer func() {
		_ = spool.Close()
		_ = os.Remove(spool.Name())
	}()
	rd := &packReader{ctx: ctx, limits: limits, spool: spool, seen: map[string]bool{}}
	entries, err := rd.read(r)
	if err != nil {
		return nil, err
	}
	sources, err := filterEntries(entries, spool)
	if err != nil {
		return nil, err
	}
	sortSources(sources)
	var errs PackErrors
	if checkLinkChains(sources, &errs); len(errs) > 0 {
		return nil, errs
	}
	return writePack(ctx, sources, limits)
}

type packReader struct {
	ctx    context.Context
	limits PackLimits
	spool  *os.File
	pos    int64
	seen   map[string]bool
	errs   PackErrors
}

// capReader counts bytes and fails once max (when > 0) is exceeded.
type capReader struct {
	r   io.Reader
	n   int64
	max int64
	err error
}

func (c *capReader) Read(b []byte) (int, error) {
	n, err := c.r.Read(b)
	c.n += int64(n)
	if c.max > 0 && c.n > c.max {
		return n, c.err
	}
	return n, err
}

func (rd *packReader) read(r io.Reader) ([]Entry, error) {
	compressed := &capReader{r: r, max: rd.limits.MaxPackBytes, err: capError(CapPackBytes, rd.limits.MaxPackBytes)}
	gz, err := gzip.NewReader(compressed)
	if err != nil {
		return nil, archiveError(err)
	}
	gz.Multistream(false)
	uncompressed := &capReader{r: gz, max: rd.limits.MaxBytes, err: capError(CapBytes, rd.limits.MaxBytes)}
	tr := tar.NewReader(uncompressed)
	var entries []Entry
	for {
		if err := rd.ctx.Err(); err != nil {
			return nil, err
		}
		hdr, err := tr.Next()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return nil, archiveError(err)
		}
		e, ok, err := rd.entry(hdr, tr)
		if err != nil {
			return nil, archiveError(err)
		}
		if !ok {
			continue
		}
		entries = append(entries, e)
		if rd.limits.MaxFiles > 0 && len(entries) > rd.limits.MaxFiles {
			return nil, PackErrors{filesCapError(rd.limits.MaxFiles)}
		}
	}
	// Drain the rest of the gzip stream so trailing garbage and the caps are noticed.
	if _, err := io.Copy(io.Discard, uncompressed); err != nil {
		return nil, archiveError(err)
	}
	if len(rd.errs) > 0 {
		return nil, rd.errs
	}
	return entries, nil
}

// entry validates one header and spools a regular file's content. ok is false for entries that carry
// no task content (PAX global headers) and for rejected entries, which are recorded in rd.errs.
func (rd *packReader) entry(hdr *tar.Header, tr io.Reader) (Entry, bool, error) {
	name := strings.TrimPrefix(hdr.Name, "./")
	if hdr.Typeflag == tar.TypeDir {
		name = strings.TrimSuffix(name, "/")
	}
	if hdr.Typeflag == tar.TypeXGlobalHeader || name == "" || name == "." {
		return Entry{}, false, nil
	}
	if msg := checkPath(name); msg != "" {
		rd.errs.add(name, "%s", msg)
		return Entry{}, false, nil
	}
	if rd.seen[name] {
		rd.errs.add(name, "appears twice in the archive")
		return Entry{}, false, nil
	}
	rd.seen[name] = true
	perm := os.FileMode(hdr.Mode).Perm() //nolint:gosec // only the permission bits are used
	switch hdr.Typeflag {
	case tar.TypeDir:
		return Entry{Path: name, Kind: KindDir, Mode: modeDir}, true, nil
	case tar.TypeSymlink:
		if msg := checkLink(name, hdr.Linkname); msg != "" {
			rd.errs.add(name, "%s", msg)
			return Entry{}, false, nil
		}
		return Entry{Path: name, Kind: KindSymlink, Mode: modeSymlink, Link: hdr.Linkname}, true, nil
	case tar.TypeReg:
		offset := rd.pos
		n, err := io.Copy(rd.spool, tr)
		if err != nil {
			return Entry{}, false, err
		}
		rd.pos += n
		return Entry{Path: name, Kind: KindFile, Mode: fileMode(perm), Size: n, offset: offset}, true, nil
	case tar.TypeLink:
		rd.errs.add(name, "is a hard link; a pack may contain only regular files, directories and symlinks")
	default:
		rd.errs.add(name, "has the unsupported entry type %q; a pack may contain only regular files, directories and symlinks", string(hdr.Typeflag))
	}
	return Entry{}, false, nil
}

// archiveError turns a broken archive into a content problem and keeps caps and cancellation.
func archiveError(err error) error {
	var pe *PackError
	switch {
	case errors.As(err, &pe):
		return PackErrors{pe}
	case errors.Is(err, context.Canceled), errors.Is(err, context.DeadlineExceeded):
		return err
	default:
		return PackErrors{{Message: fmt.Sprintf("the pack is not a valid tar.gz archive: %v", err)}}
	}
}

// filterEntries applies the hard excludes and the pack's own .dockerignore to entries read from an
// archive, keeps the directories above included entries and returns the sources to write.
func filterEntries(entries []Entry, spool *os.File) ([]source, error) {
	var files *FileSet
	for _, e := range entries {
		if e.Path != DockerignoreName {
			continue
		}
		if e.Kind != KindFile {
			return nil, PackErrors{{Path: DockerignoreName, Message: "must be a regular file"}}
		}
		if e.Size > maxIgnoreFileBytes {
			return nil, PackErrors{{Path: DockerignoreName, Message: fmt.Sprintf("is larger than %d bytes", maxIgnoreFileBytes)}}
		}
		data := make([]byte, e.Size)
		if _, err := spool.ReadAt(data, e.offset); err != nil {
			return nil, fmt.Errorf("read .dockerignore: %w", err)
		}
		var err error
		if files, err = NewFileSet(data); err != nil {
			return nil, PackErrors{{Path: DockerignoreName, Message: err.Error()}}
		}
	}

	kinds := make(map[string]EntryKind, len(entries))
	for _, e := range entries {
		kinds[e.Path] = e.Kind
	}
	for _, e := range entries {
		for _, dir := range ancestors(e.Path) {
			if k, ok := kinds[dir]; ok && k != KindDir {
				return nil, PackErrors{{Path: e.Path, Message: fmt.Sprintf("its parent %s is not a directory", dir)}}
			}
		}
	}

	kept := map[string]bool{}
	var sources []source
	keep := func(e Entry) {
		kept[e.Path] = true
		s := source{Entry: e}
		if e.Kind == KindFile {
			section := io.NewSectionReader(spool, e.offset, e.Size)
			s.open = func() (io.ReadCloser, int64, error) { return io.NopCloser(section), e.Size, nil }
		}
		sources = append(sources, s)
	}
	for _, e := range entries {
		// Each entry is decided on its own path, so an excluded directory is dropped here and comes back
		// below when an exception re-includes something under it.
		inclusion, err := files.Classify(e.Path, false)
		if err != nil {
			var pe *PackError
			if errors.As(err, &pe) {
				return nil, PackErrors{pe}
			}
			return nil, err
		}
		if inclusion == Included {
			keep(e)
		}
	}
	// Directories above kept entries are part of the pack even when the archive has no entry for them
	// or .dockerignore excludes them (an exception re-included something below).
	for _, s := range sources {
		for _, dir := range ancestors(s.Path) {
			if !kept[dir] {
				kept[dir] = true
				sources = append(sources, source{Entry: Entry{Path: dir, Kind: KindDir, Mode: modeDir}})
			}
		}
	}
	return sources, nil
}
