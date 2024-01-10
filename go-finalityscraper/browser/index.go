package browser

import (
	"crypto/rand"
	"fmt"

	"github.com/PuerkitoBio/goquery"
	"github.com/headzoo/surf/browser"
	"gopkg.in/headzoo/surf.v1"
)

func First(selection *goquery.Selection, selector string) *goquery.Selection {
	found := selection.Find(selector)
	if found.Length() == 0 {
		return nil
	}
	return found.First()
}

type Browser struct {
	b *browser.Browser
}

func NewBrowser() *Browser {
	return &Browser{surf.NewBrowser()}
}

var user_agent_arr = []string{
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/42.0.2311.135 Safari/537.36 Edge/12.246",
	"Mozilla/5.0 (X11; CrOS x86_64 8172.45.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/51.0.2704.64 Safari/537.36",
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_11_2) AppleWebKit/601.3.9 (KHTML, like Gecko) Version/9.0.2 Safari/601.3.9",
	"Mozilla/5.0 (Windows NT 6.1; WOW64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/47.0.2526.111 Safari/537.36",
	"Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:15.0) Gecko/20100101 Firefox/15.0.1",
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118.0.0.0 Safari/537.36 OPR/104.0.0.0",
}

func RandomUserAgent() string {
	user_agent_arr_len := len(user_agent_arr)
	b := make([]byte, 1)
	rand.Read(b)
	return user_agent_arr[int(b[0])%user_agent_arr_len]
}

func (b *Browser) Open(url string) {
	// Randomize the user agent
	b.b.SetUserAgent(RandomUserAgent())

	fmt.Println("Opening", url)
	b.b.Open(url)
}

func (b *Browser) First(selector string) *goquery.Selection {
	return First(b.b.Dom(), selector)
}
