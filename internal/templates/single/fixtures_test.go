package single_test

import (
	"testing"

	"github.com/lonetis/scantor/internal/templates/core"
	"github.com/lonetis/scantor/internal/templates/single"
	"github.com/lonetis/scantor/internal/templates/templatestest"
)

func TestFixtures(t *testing.T) {
	templatestest.RunFixtures(t, func() core.Template { return single.New() })
}
