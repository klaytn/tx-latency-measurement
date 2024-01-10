package parse

import (
	"strconv"
	"strings"
)

func ParsePages(pagesStr string) ([]int, error) {
	pages := []int{}
	strs := strings.Split(pagesStr, ",")

	for _, str := range strs {
		if strings.Contains(str, "-") {
			rangeStrs := strings.Split(str, "-")
			start, err := strconv.Atoi(rangeStrs[0])
			if err != nil {
				return nil, err
			}
			end, err := strconv.Atoi(rangeStrs[1])
			if err != nil {
				return nil, err
			}
			for i := start; i <= end; i++ {
				pages = append(pages, i)
			}
		} else {
			page, err := strconv.Atoi(str)
			if err != nil {
				return nil, err
			}
			pages = append(pages, page)
		}
	}

	return pages, nil
}
