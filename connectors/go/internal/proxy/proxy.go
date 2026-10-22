// Package proxy implements the template proxies shared by the packages under templates/: a wrapped
// template call streams analysis configs from the runtime (docs/templates.md §3).
package proxy

import (
	"encoding/json"
	"errors"
	"iter"
)

// engine is implemented by the scantor.Context the connector passes to schedule.
type engine interface {
	StreamTemplate(name string, scanConfig any) iter.Seq2[json.RawMessage, error]
	DecodeTemplateItem(raw json.RawMessage, target any) error
}

// Schedule streams the analysis configs of template name for scanConfig. ctx must be the
// scantor.Context of the schedule call. Stopping the iteration early cancels the template stream.
func Schedule[AC any](ctx any, name string, scanConfig any) iter.Seq2[AC, error] {
	return func(yield func(AC, error) bool) {
		var zero AC
		e, ok := ctx.(engine)
		if !ok {
			yield(zero, errors.New("template proxies need the scantor.Context that schedule received"))
			return
		}
		for raw, err := range e.StreamTemplate(name, scanConfig) {
			if err != nil {
				yield(zero, err)
				return
			}
			var item AC
			if err := e.DecodeTemplateItem(raw, &item); err != nil {
				yield(zero, err)
				return
			}
			if !yield(item, nil) {
				return
			}
		}
	}
}
