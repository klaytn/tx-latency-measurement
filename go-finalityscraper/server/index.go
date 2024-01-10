package server

import (
	"fmt"
	"go-finalityscraper/common/chans"
	"net/http"
	"os"
	"sync"

	"github.com/labstack/echo"
	"github.com/labstack/echo/middleware"
)

type HasCode struct {
	Code int
}
type ErrRes struct {
	Err string `json:"err"`
}
type HasErr struct {
	HasCode
	ErrRes
}

func NewHasErr(code int, err error) HasErr {
	return HasErr{
		HasCode: HasCode{
			Code: code,
		},
		ErrRes: ErrRes{
			Err: err.Error(),
		},
	}
}

type ResMap struct {
	*sync.Map
}

type Server struct {
	l2_hash chans.L2HashChan

	e       *echo.Echo
	res_map *ResMap
}

func NewServer(l2_hash chans.L2HashChan) *Server {
	sv := &Server{
		l2_hash: l2_hash,

		e:       echo.New(),
		res_map: &ResMap{&sync.Map{}},
	}

	sv.e.Use(middleware.Logger())
	sv.e.Use(middleware.Recover())

	sv.e.GET("/", func(c echo.Context) error {
		return c.HTML(http.StatusOK, "Hello, Docker! <3")
	})

	sv.e.GET("/health", func(c echo.Context) error {
		return c.JSON(http.StatusOK, struct{ Status string }{Status: "OK"})
	})

	sv.e.GET("/root_end", sv.root_end_GET)

	return sv
}

func (sv *Server) Start() {
	httpPort := os.Getenv("PORT")
	if httpPort == "" {
		httpPort = "8080"
	}
	sv.e.Logger.Fatal(sv.e.Start(":" + httpPort))
}

func (sv *Server) getResChan(id string) (chans.AnyChan, bool) {
	res_chan, res_chan_exists := sv.res_map.Load(id)
	if res_chan_exists {
		return res_chan.(chans.AnyChan), true
	}
	return nil, false
}

func (sv *Server) initResChan(id string) chans.AnyChan {
	root_end_chan := make(chans.AnyChan)
	sv.res_map.Store(id, root_end_chan)
	return root_end_chan
}

func (sv *Server) SetChanRes(id string, v any) error {
	res_chan, res_chan_exists := sv.getResChan(id)
	if res_chan_exists {
		res_chan <- v
		return nil
	}
	return fmt.Errorf("res_map id not found: %s", id)
}
