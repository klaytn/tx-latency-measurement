package l2_browser

import "github.com/PuerkitoBio/goquery"

func (b *B) queryl1StateBatchTx_optimism() *goquery.Selection {
	return b.First("#ContentPlaceHolder1_l1StateBatchTxRow > div > div:last-child > a")
}
