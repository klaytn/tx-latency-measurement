package txs_browser

import (
	"fmt"
	"go-finalityscraper/browser"
	"go-finalityscraper/common/chain"
	"go-finalityscraper/common/chans"
	"go-finalityscraper/latency_map"
	"strconv"
	"sync"

	"github.com/PuerkitoBio/goquery"
)

const txs_route string = "/txs?ps=10&p="

type B struct {
	// ModeScan
	wg *sync.WaitGroup
	lm *latency_map.LatencyMap

	// chans
	p       chans.PChan
	l2_hash chans.L2HashChan

	// Internal
	*browser.Browser
	process func(from_chain_url chain.ChainUrl)
}

func NewB(p chans.PChan, l2_hash chans.L2HashChan) *B {
	return &B{
		p:       p,
		l2_hash: l2_hash,

		Browser: browser.NewBrowser(),
	}
}

func (b *B) SetModeScan(wg *sync.WaitGroup, lm *latency_map.LatencyMap) {
	b.wg = wg
	b.lm = lm
	b.process = b.processForScan
}

func (b *B) Main(from_chain_url chain.ChainUrl) {
	for {
		p := <-b.p
		b.Open(string(from_chain_url) + txs_route + strconv.Itoa(p))
		b.process(from_chain_url)
	}
}

func (b *B) processForScan(from_chain_url chain.ChainUrl) {
	// Dec wg txs_b
	defer b.wg.Done()

	tbody_el := b.First("tbody")

	// Inc wg txs_b process
	b.wg.Add(1)
	go func() {
		// Dec wg txs_b process
		defer b.wg.Done()
		bp := b.newProcess()

		bp.processTBody(tbody_el, func(_ int, tr_el *goquery.Selection) {
			// Inc wg txs_b process tr
			b.wg.Add(1)
			go func() {
				// Dec wg txs_b process tr
				defer b.wg.Done()

				hash, hash_err := bp.processTd(tr_el)
				if hash_err != nil {
					fmt.Println(hash_err)
					return
				}

				_, hash_exists := b.lm.Get(hash)
				if hash_exists {
					fmt.Println("Skipping:", hash+", already exists")
					return
				}

				b.lm.InitHash(hash)
				// Inc wg l2_b
				b.wg.Add(1)
				b.l2_hash <- chain.L2Hash{
					ChainUrl: from_chain_url,
					Hash:     hash,
				}
			}()
		})
	}()
}

type bProcess struct {
}

func (b *B) newProcess() *bProcess {
	return &bProcess{}
}

func (bp *bProcess) processTBody(tbody_el *goquery.Selection, trFn func(int, *goquery.Selection)) {
	if tbody_el == nil {
		return
	}
	tbody_el.Find("tr").Each(trFn)
}

func (bp *bProcess) processTd(tr_el *goquery.Selection) (string, error) {
	from_el := browser.First(tr_el, "td:nth-child(7)")
	if from_el == nil {
		return "", fmt.Errorf("from address not found")
	}

	// Filter non-System txs
	if from_el.Text() != "System Address" {
		tx_el := tr_el.Find("td:nth-child(2) a")
		if tx_el == nil {
			return "", fmt.Errorf("tx hash not found")
		}

		hash := tx_el.Text()
		return hash, nil
	} else {
		return "", fmt.Errorf("Skipping: System Address")
	}
}
