package ranges_test

import (
	"testing"

	"github.com/lonetis/scantor/internal/templates/core"
	ranges "github.com/lonetis/scantor/internal/templates/range"
	"github.com/lonetis/scantor/internal/templates/templatestest"
)

func TestFixtures(t *testing.T) {
	templatestest.RunFixtures(t, func() core.Template { return ranges.New() })
}
