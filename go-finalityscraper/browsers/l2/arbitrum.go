package l2_browser

import "github.com/PuerkitoBio/goquery"

func (b *B) queryl1StateBatchTx_arbitrum() *goquery.Selection {
	return b.First("#ContentPlaceHolder1_l1TransactionRow > div > div:last-child > a")
}
