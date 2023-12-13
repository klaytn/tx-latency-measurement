package chans

import "go-finalityscraper/common/chain"

type AnyChan chan any
type DoneChan chan bool
type ErrChan chan error
type PChan chan int

type L2HashChan chan chain.L2Hash
type RootL2HashChan chan chain.RootL2Hash
