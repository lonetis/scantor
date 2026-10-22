package repeat_test

import (
	"testing"

	"github.com/lonetis/scantor/internal/templates/core"
	"github.com/lonetis/scantor/internal/templates/repeat"
	"github.com/lonetis/scantor/internal/templates/templatestest"
)

func TestFixtures(t *testing.T) {
	templatestest.RunFixtures(t, func() core.Template { return repeat.New() })
}
