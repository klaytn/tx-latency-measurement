package browsers_manager

import (
	l2_browser "go-finalityscraper/browsers/l2"
	root_browser "go-finalityscraper/browsers/root"
	txs_browser "go-finalityscraper/browsers/txs"
	"go-finalityscraper/common/chain"
	"go-finalityscraper/common/chans"
	"go-finalityscraper/latency_map"
	"go-finalityscraper/server"
	"sync"
)

type BrowserManager struct {
	wg *sync.WaitGroup
	// for txs_b
	p chans.PChan
	// for l2_b
	l2_hash chans.L2HashChan
	// An eventual duplicate of l2_hash, but for root_b
	root_l2_hash chans.RootL2HashChan

	txs_b  *txs_browser.B
	l2_b   *l2_browser.B
	root_b *root_browser.B
}

func NewBrowserManager(
	p chans.PChan,
	l2_hash chans.L2HashChan,
	root_l2_hash chans.RootL2HashChan,
) *BrowserManager {
	bm := &BrowserManager{
		wg:           &sync.WaitGroup{},
		p:            p,
		l2_hash:      l2_hash,
		root_l2_hash: root_l2_hash,

		txs_b:  txs_browser.NewB(p, l2_hash),
		l2_b:   l2_browser.NewB(l2_hash, root_l2_hash),
		root_b: root_browser.NewB(root_l2_hash),
	}

	return bm
}

func (bm *BrowserManager) StartScan(lm *latency_map.LatencyMap, from_chain_url chain.ChainUrl) {
	// Setup
	bm.txs_b.SetModeScan(bm.wg, lm)
	bm.l2_b.SetModeScan(bm.wg, lm)
	bm.root_b.SetModeScan(bm.wg, lm)

	// Start
	go bm.txs_b.Main(from_chain_url)
	go bm.l2_b.Main()
	go bm.root_b.Main()
}

func (bm *BrowserManager) StartServer(server *server.Server) {
	// Setup
	bm.l2_b.SetModeServer(server)
	bm.root_b.SetModeServer(server)

	// Start
	go bm.l2_b.Main()
	go bm.root_b.Main()
}

func (bm *BrowserManager) AddP(p int) {
	// Inc wg txs_b
	bm.wg.Add(1)
	bm.p <- p
}

func (bm *BrowserManager) Wait() {
	bm.wg.Wait()
}
