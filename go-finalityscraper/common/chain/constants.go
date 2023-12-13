package chain

const (
	L1Url = "https://etherscan.io"
)

type ChainId string

const (
	ChainIdOptimism       ChainId = "10"
	ChainIdOptimismGoerli ChainId = "420"
	ChainIdArbitrum       ChainId = "42161"
	ChainIdArbitrumGoerli ChainId = "421613"
)

type ChainUrl string

const (
	ChainUrlOptimism       ChainUrl = "https://optimistic.etherscan.io"
	ChainUrlOptimismGoerli ChainUrl = "https://goerli-optimism.etherscan.io"
	ChainUrlArbitrum       ChainUrl = "https://arbiscan.io"
	ChainUrlArbitrumGoerli ChainUrl = "https://goerli.arbiscan.io"
)

type L2Hash struct {
	ChainUrl ChainUrl
	Hash     string
}

type RootL2Hash struct {
	Hash string
	Href string
}
