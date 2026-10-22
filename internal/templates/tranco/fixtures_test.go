package tranco_test

import (
	"testing"

	"github.com/lonetis/scantor/internal/templates/core"
	"github.com/lonetis/scantor/internal/templates/templatestest"
	"github.com/lonetis/scantor/internal/templates/tranco"
)

func TestFixtures(t *testing.T) {
	templatestest.RunFixtures(t, func() core.Template { return tranco.NewWithAPIInterval(0) })
}
