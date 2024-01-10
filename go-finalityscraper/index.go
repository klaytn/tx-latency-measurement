package main

import (
	"fmt"
	browser_manager "go-finalityscraper/browsers"
	"go-finalityscraper/common/chain"
	"go-finalityscraper/common/chans"
	"go-finalityscraper/common/modes"
	"go-finalityscraper/latency_map"
	"go-finalityscraper/parse"
	"go-finalityscraper/server"
	"os"

	"github.com/joho/godotenv"
)

const csv_path = "data.csv"

func main() {
	// Load env
	err := godotenv.Load()
	if err != nil {
		panic(err)
	}

	p := make(chans.PChan)
	l2_hash := make(chans.L2HashChan)
	root_l2_hash := make(chans.RootL2HashChan)
	bm := browser_manager.NewBrowserManager(
		p,
		l2_hash,
		root_l2_hash,
	)
	mode := modes.Validate(os.Getenv("MODE"))

	switch mode {
	case modes.ModeScan:
		MainScan(bm)
	case modes.ModeServer:
		MainServer(bm, l2_hash)
	}

}

func MainScan(bm *browser_manager.BrowserManager) {
	lm := latency_map.NewLatencyMap(csv_path)

	scan_pages_str := os.Getenv("SCAN_PAGES")
	scan_pages, err := parse.ParsePages(scan_pages_str)
	if err != nil {
		panic(err)
	}
	fmt.Println("Scan pages:", scan_pages)

	scan_from_chain_id := os.Getenv("SCAN_FROM_CHAIN")
	from_chain_url, from_chain_url_err := chain.MapChainIdUrl(chain.ChainId(scan_from_chain_id))
	if from_chain_url_err != nil {
		panic(from_chain_url_err)
	}
	fmt.Println("Scan chain:", from_chain_url)

	bm.StartScan(lm, from_chain_url)
	for _, p := range scan_pages {
		bm.AddP(p)
	}
	bm.Wait()

	lm.WriteCsv()
	latency_avg, latency_max := lm.Agg()
	fmt.Println("Avg latency:", parse.FormatMs(latency_avg)+"; Max:", parse.FormatMs(latency_max))
}

func MainServer(bm *browser_manager.BrowserManager, l2_hash chans.L2HashChan) {
	server := server.NewServer(l2_hash)

	bm.StartServer(server)
	bm.Wait()

	server.Start()
}
