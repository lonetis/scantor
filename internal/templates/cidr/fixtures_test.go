package cidr_test

import (
	"testing"

	"github.com/lonetis/scantor/internal/templates/cidr"
	"github.com/lonetis/scantor/internal/templates/core"
	"github.com/lonetis/scantor/internal/templates/templatestest"
)

func TestFixtures(t *testing.T) {
	templatestest.RunFixtures(t, func() core.Template { return cidr.New() })
}
