package worker

import (
	"os"
	"testing"

	"github.com/lonetis/scantor/internal/runtime/internal/fakeconn"
)

// afterTests run once after all tests (integration tests register the removal of shared containers).
var afterTests []func()

func TestMain(m *testing.M) {
	if fakeconn.Active() {
		fakeconn.Main()
		return
	}
	code := m.Run()
	for _, fn := range afterTests {
		fn()
	}
	os.Exit(code)
}
