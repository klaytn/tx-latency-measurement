package latency_map

import (
	"encoding/csv"
	"fmt"
	"os"
	"strconv"
	"sync"
	"sync/atomic"
)

type I int

const (
	Start I = iota
	RootEnd
)

type MV [2]string
type Entry struct {
	Hash string
	I    I
	V    string
}

const cols = 2

type LatencyMap struct {
	path string

	// Tx hash -> was in read csv
	existing_set map[string]bool
	// Tx hash -> [start, end]
	*sync.Map
	m_len *atomic.Uint32
}

func NewLatencyMap(path string) *LatencyMap {
	lm := &LatencyMap{
		path: path,

		existing_set: map[string]bool{},
		Map:          &sync.Map{},
		m_len:        &atomic.Uint32{},
	}

	csv := lm.ReadCsv()
	lm.ParseCsv(csv)

	return lm
}

func (lm *LatencyMap) Print() {
	lm.Iter(func(hash string, v *MV) bool {
		fmt.Println(hash, v)
		return true
	})
}

func (lm *LatencyMap) Get(hash string) (*MV, bool) {
	v, exists := lm.Load(hash)
	if exists {
		return v.(*MV), true
	}
	return nil, false
}

func (lm *LatencyMap) InitHash(hash string) {
	lm.Store(hash, &MV{})
	lm.m_len.Add(1)
}

func (lm *LatencyMap) SetHashI(entry Entry) error {
	v, exists := lm.Load(entry.Hash)
	if exists {
		v.(*MV)[entry.I] = entry.V
		return nil
	}
	return fmt.Errorf("hash not found: %s", entry.Hash)
}

func (lm *LatencyMap) RemoveHash(hash string) {
	lm.Delete(hash)
	lm.m_len.Store(lm.Len() - 1)
}

// (mean, max)
func (lm *LatencyMap) Agg() (float64, float64) {
	var sum float64 = 0
	var max float64 = 0
	lm.Iter(func(hash string, v *MV) bool {
		start, start_err := strconv.ParseFloat(v[Start], 64)
		if start_err != nil {
			panic(start_err)
		}
		root_end, root_end_err := strconv.ParseFloat(v[RootEnd], 64)
		if root_end_err != nil {
			panic(root_end_err)
		}
		latency := root_end - start
		sum += latency
		if latency > max {
			max = latency
		}
		return true
	})
	mean := sum / float64(lm.Len())
	return mean, max
}

func (lm *LatencyMap) ReadCsv() [][]string {
	file, err := os.OpenFile(lm.path, os.O_CREATE|os.O_RDONLY, 0644)
	if err != nil {
		panic(err)
	}
	defer file.Close()

	reader := csv.NewReader(file)

	csv, err := reader.ReadAll()
	if err != nil {
		panic(err)
	}

	return csv
}

func (lm *LatencyMap) ParseCsv(csv [][]string) {
	rows := len(csv)
	if rows == 0 {
		return
	}

	cols := len(csv[0])
	for row := 0; row < rows; row++ {
		str_record := csv[row]
		hash := str_record[0]
		lm.InitHash(hash)
		for col := 1; col < cols; col++ {
			v := csv[row][col]
			lm.SetHashI(Entry{
				Hash: hash,
				I:    I(col - 1),
				V:    v,
			})
		}
		lm.existing_set[hash] = true
	}
}

func (lm *LatencyMap) WriteCsv() {
	file, err := os.OpenFile(lm.path, os.O_APPEND|os.O_WRONLY, 0644)
	if err != nil {
		panic(err)
	}
	defer file.Close()

	writer := csv.NewWriter(file)

	lm.Iter(func(hash string, v *MV) bool {
		if lm.existing_set[hash] {
			return true
		}
		for col := 0; col < cols; col++ {
			col_v := v[I(col)]
			err := writer.Write([]string{hash, col_v})
			if err != nil {
				panic(err)
			}
			writer.Flush()
		}
		return true
	})
}

func (lm *LatencyMap) Iter(fn func(hash string, v *MV) bool) {
	lm.Range(func(k, v interface{}) bool {
		return fn(k.(string), v.(*MV))
	})
}

func (lm *LatencyMap) Len() uint32 {
	return lm.m_len.Load()
}
