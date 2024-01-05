package modes

import "fmt"

type Mode string

const (
	ModeScan   Mode = "scan"
	ModeServer Mode = "server"
)

func Validate(mode string) Mode {
	switch mode {
	case string(ModeScan):
		return Mode(mode)
	case string(ModeServer):
		return Mode(mode)
	default:
		panic(fmt.Sprintf("Invalid mode: %s", mode))
	}
}
