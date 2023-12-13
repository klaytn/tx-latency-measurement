package chain

import "fmt"

func MapChainIdUrl(chain_id ChainId) (ChainUrl, error) {
	switch chain_id {
	case ChainIdOptimism:
		return ChainUrlOptimism, nil
	case ChainIdOptimismGoerli:
		return ChainUrlOptimismGoerli, nil
	case ChainIdArbitrum:
		return ChainUrlArbitrum, nil
	case ChainIdArbitrumGoerli:
		return ChainUrlArbitrumGoerli, nil
	default:
		return "", fmt.Errorf("Unknown chain id: %s", chain_id)
	}
}
