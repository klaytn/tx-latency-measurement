package server

import (
	"go-finalityscraper/common/chain"
	"net/http"

	"github.com/labstack/echo"
)

type RootEndRes struct {
	RootEnd string `json:"root_end"`
}
type RootEndV struct {
	HasCode
	RootEndRes
}

func (sv *Server) root_end_GET(c echo.Context) error {
	from_chain_id := c.QueryParam("from_chain")
	from_chain_url, from_chain_url_err := chain.MapChainIdUrl(chain.ChainId(from_chain_id))
	if from_chain_url_err != nil {
		return c.JSON(http.StatusBadRequest, ErrRes{
			Err: from_chain_url_err.Error(),
		})
	}

	hash := c.QueryParam("hash")

	res_chan := sv.initResChan(hash)
	sv.l2_hash <- chain.L2Hash{
		ChainUrl: from_chain_url,
		Hash:     hash,
	}
	res := <-res_chan

	has_err, has_err_ok := res.(HasErr)
	if has_err_ok {
		return c.JSON(has_err.Code, ErrRes{
			Err: has_err.Err,
		})
	}

	root_end, root_end_ok := res.(RootEndV)
	if root_end_ok {
		return c.JSON(root_end.Code, RootEndRes{
			RootEnd: root_end.RootEnd,
		})
	}

	return c.JSON(500, ErrRes{
		Err: "Unknown error",
	})
}
