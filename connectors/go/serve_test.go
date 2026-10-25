package scantor

import (
	"os"
	"syscall"
	"testing"
)

func closeOnExec(t *testing.T, fd int) bool {
	t.Helper()
	flags, _, errno := syscall.Syscall(syscall.SYS_FCNTL, uintptr(fd), syscall.F_GETFD, 0)
	if errno != 0 {
		t.Fatalf("fcntl(%d, F_GETFD): %v", fd, errno)
	}
	return flags&syscall.FD_CLOEXEC != 0
}

// TestProtocolFDsAreCloseOnExec checks that child processes of task code never inherit the protocol
// pipes: the runtime passes them through ExtraFiles, which clears FD_CLOEXEC, as syscall.Pipe does here.
func TestProtocolFDsAreCloseOnExec(t *testing.T) {
	var toConn, fromConn [2]int
	if err := syscall.Pipe(toConn[:]); err != nil {
		t.Fatal(err)
	}
	if err := syscall.Pipe(fromConn[:]); err != nil {
		t.Fatal(err)
	}
	defer syscall.Close(toConn[1])
	defer syscall.Close(fromConn[0])
	inFD, outFD := toConn[0], fromConn[1]
	if closeOnExec(t, inFD) || closeOnExec(t, outFD) {
		t.Fatal("the test pipes are already close-on-exec")
	}
	in, out, ok := openProtocolFDs(inFD, outFD)
	if !ok {
		t.Fatal("openProtocolFDs rejected two pipes")
	}
	defer in.(*os.File).Close()
	defer out.(*os.File).Close()
	for _, fd := range []int{inFD, outFD} {
		if !closeOnExec(t, fd) {
			t.Errorf("fd %d is inherited by child processes", fd)
		}
	}
}
