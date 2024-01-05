package root_browser

import (
	"fmt"
	"go-finalityscraper/browser"
	"go-finalityscraper/common/chans"
	"go-finalityscraper/latency_map"
	"go-finalityscraper/parse"
	"go-finalityscraper/server"
	"net/http"
	"strconv"
	"sync"

	"github.com/PuerkitoBio/goquery"
)

type rootBProcessResult struct {
	done chans.DoneChan
	// root_end
	result string
}
type rootBHrefProcessMap struct {
	*sync.Map
}

func (m *rootBHrefProcessMap) Get(href string) (*rootBProcessResult, bool) {
	process, process_exists := m.Load(href)
	if process_exists {
		return process.(*rootBProcessResult), true
	}
	return nil, false
}

type B struct {
	// ModeScan
	wg *sync.WaitGroup
	lm *latency_map.LatencyMap

	// ModeServer
	sv *server.Server

	// chans
	root_l2_hash chans.RootL2HashChan

	// Internal
	*browser.Browser
	Process          func(hash string, href string)
	href_process_map *rootBHrefProcessMap
}

func NewB(root_l2_hash chans.RootL2HashChan) *B {
	return &B{
		root_l2_hash: root_l2_hash,
		Browser:      browser.NewBrowser(),
	}
}

func (b *B) SetModeScan(wg *sync.WaitGroup, lm *latency_map.LatencyMap) {
	b.wg = wg
	b.lm = lm
	b.href_process_map = &rootBHrefProcessMap{&sync.Map{}}
	b.Process = b.processForScan
}

func (b *B) SetModeServer(sv *server.Server) {
	b.sv = sv
	b.Process = b.processForServer
}

func (b *B) Main() {
	for {
		root_l2_hash := <-b.root_l2_hash
		hash := root_l2_hash.Hash
		href := root_l2_hash.Href
		b.Process(hash, href)
	}
}

func (b *B) processForScan(hash string, href string) {
	// Dec wg root_b
	defer b.wg.Done()

	process, process_exists := b.href_process_map.Get(href)
	if !process_exists {
		process = &rootBProcessResult{
			done:   make(chans.DoneChan),
			result: "",
		}
		b.href_process_map.Store(href, process)

		b.Open(href)
		ts_el := b.First("#showUtcLocalDate")

		go func() {
			defer close(process.done)
			bp := b.newProcess()

			root_end, root_end_err := bp.Process(ts_el)
			if root_end_err != nil {
				fmt.Println(root_end_err)
				b.lm.RemoveHash(hash)
				return
			}
			process.result = root_end
		}()
	}

	// Inc wg root_b process
	b.wg.Add(1)
	go func() {
		// Dec wg root_b process
		defer b.wg.Done()
		<-(process.done)
		b.lm.SetHashI(latency_map.Entry{
			Hash: hash,
			I:    latency_map.RootEnd,
			V:    process.result,
		})
	}()
}

func (b *B) processForServer(hash string, href string) {
	b.Open(href)
	ts_el := b.First("#showUtcLocalDate")

	go func() {
		bp := b.newProcess()

		root_end, root_end_err := bp.Process(ts_el)
		if root_end_err != nil {
			fmt.Println(root_end_err)
			b.sv.SetChanRes(hash, server.NewHasErr(http.StatusNotFound, root_end_err))
			return
		}

		b.sv.SetChanRes(hash, server.RootEndV{
			HasCode: server.HasCode{
				Code: http.StatusOK,
			},
			RootEndRes: server.RootEndRes{
				RootEnd: root_end,
			},
		})
	}()
}

type bProcess struct {
}

func (b *B) newProcess() *bProcess {
	return &bProcess{}
}

func (bp *bProcess) Process(ts_el *goquery.Selection) (string, error) {
	if ts_el == nil {
		return "", fmt.Errorf("Timestamp el not found")
	}

	root_end_time, root_end_err := parse.Date(ts_el.Text())
	if root_end_err != nil {
		return "", fmt.Errorf("Error parsing timestamp: %w", root_end_err)
	}

	root_end := strconv.FormatInt(root_end_time.UnixMilli(), 10)
	return root_end, nil
}
