package l2_browser

import (
	"fmt"
	"go-finalityscraper/browser"
	"go-finalityscraper/common/chain"
	"go-finalityscraper/common/chans"
	"go-finalityscraper/latency_map"
	"go-finalityscraper/parse"
	"go-finalityscraper/server"
	"math/big"
	"net/http"
	"strconv"
	"sync"

	"github.com/PuerkitoBio/goquery"
	"github.com/dlclark/regexp2"
)

var block_re = regexp2.MustCompile(`(?<=\[(?:1|3)\]:  )[0-9a-f]{64}`, regexp2.IgnoreCase)

type B struct {
	// ModeScan
	wg *sync.WaitGroup
	lm *latency_map.LatencyMap

	// ModeServer
	sv *server.Server

	// chans
	l2_hash      chans.L2HashChan
	root_l2_hash chans.RootL2HashChan

	// Internal
	*browser.Browser
	process func(hash string, l1StateBatchTx_el *goquery.Selection)
}

func NewB(l2_hash chans.L2HashChan, root_l2_hash chans.RootL2HashChan) *B {
	return &B{
		l2_hash:      l2_hash,
		root_l2_hash: root_l2_hash,

		Browser: browser.NewBrowser(),
	}
}

func (b *B) SetModeScan(wg *sync.WaitGroup, lm *latency_map.LatencyMap) {
	b.wg = wg
	b.lm = lm
	b.process = b.processForScan
}

func (b *B) SetModeServer(sv *server.Server) {
	b.sv = sv
	b.process = b.processForServer
}

func (b *B) Main() {
	for {
		l2_hash := <-b.l2_hash
		hash := l2_hash.Hash
		from_chain_url := l2_hash.ChainUrl
		url := string(from_chain_url) + "/tx/" + hash
		b.Open(url)
		var l1StateBatchTx_el *goquery.Selection
		switch from_chain_url {
		case chain.ChainUrlArbitrum:
			l1StateBatchTx_el = b.queryl1StateBatchTx_arbitrum()
		case chain.ChainUrlArbitrumGoerli:
			l1StateBatchTx_el = b.queryl1StateBatchTx_arbitrum()
		case chain.ChainUrlOptimism:
			l1StateBatchTx_el = b.queryl1StateBatchTx_optimism()
		case chain.ChainUrlOptimismGoerli:
			l1StateBatchTx_el = b.queryl1StateBatchTx_optimism()
		}
		b.process(hash, l1StateBatchTx_el)
	}
}

func (b *B) processForScan(hash string, l1StateBatchTx_el *goquery.Selection) {
	// Dec wg l2_b
	defer b.wg.Done()
	ts_el := b.First("#ContentPlaceHolder1_divTimeStamp > div > div:last-child")

	// Inc wg l2_b process
	b.wg.Add(1)
	go func() {
		// Dec wg l2_b process
		defer b.wg.Done()
		bp := b.newProcess()

		// Inc wg l2_b process l1StateBatchTx
		b.wg.Add(1)
		go func() {
			// Dec wg l2_b process l1StateBatchTx
			defer b.wg.Done()
			href, href_err := bp.processRootHref(l1StateBatchTx_el)
			if href_err != nil {
				fmt.Println(href_err)
				b.lm.RemoveHash(hash)
				return
			}
			// Inc wg root_b
			b.wg.Add(1)
			b.root_l2_hash <- chain.RootL2Hash{
				Hash: hash,
				Href: href,
			}
		}()

		// Inc wg l2_b process ts
		b.wg.Add(1)
		go func() {
			// Dec wg l2_b process ts
			defer b.wg.Done()
			start, start_err := bp.processTs(ts_el)
			if start_err != nil {
				b.lm.RemoveHash(hash)
				fmt.Println(start_err)
				return
			}
			b.lm.SetHashI(latency_map.Entry{
				Hash: hash,
				I:    latency_map.Start,
				V:    start,
			})
		}()
	}()
}

func (b *B) processForServer(hash string, l1StateBatchTx_el *goquery.Selection) {

	go func() {
		bp := b.newProcess()

		href, href_err := bp.processRootHref(l1StateBatchTx_el)
		if href_err != nil {
			fmt.Println(href_err)
			b.sv.SetChanRes(hash, server.NewHasErr(http.StatusNotFound, href_err))
			return
		}
		b.root_l2_hash <- chain.RootL2Hash{
			Hash: hash,
			Href: href,
		}
	}()
}

type bProcess struct {
}

func (b *B) newProcess() *bProcess {
	return &bProcess{}
}

func (bp *bProcess) processRootHref(l1StateBatchTx_el *goquery.Selection) (string, error) {
	if l1StateBatchTx_el == nil {
		return "", fmt.Errorf("l1StateBatchTx el not found")
	}

	href, href_exists := l1StateBatchTx_el.Attr("href")
	if !href_exists {
		return "", fmt.Errorf("l1StateBatchTx href not found")
	}

	return href, nil
}

func (bp *bProcess) processTs(ts_el *goquery.Selection) (string, error) {
	if ts_el == nil {
		return "", fmt.Errorf("Timestamp el not found")
	}

	start_time, start_err := parse.Date(ts_el.Text())
	if start_err != nil {
		return "", fmt.Errorf("Error parsing timestamp: %w", start_err)
	}

	start := strconv.FormatInt(start_time.UnixMilli(), 10)
	return start, nil
}

func (bp *bProcess) processL1Batch(inputdata_el *goquery.Selection) error {
	if inputdata_el == nil {
		return fmt.Errorf("inputdata el not found")
	}
	block_match, block_match_err := block_re.FindStringMatch(inputdata_el.Text())
	if block_match_err != nil {
		return fmt.Errorf("Error finding block: %w", block_match_err)
	}
	l1block := HexToBigInt(block_match.String())
	fmt.Println(l1block)
	return nil
}

func HexToBigInt(hex string) *big.Int {
	bigint := new(big.Int)
	bigint.SetString(hex, 16)
	return bigint
}
