package parse

import (
	"fmt"
	"strconv"
	"time"

	"github.com/dlclark/regexp2"
)

var ts_re = regexp2.MustCompile(`([A-Z][a-z]{2})-(\d{2})-(\d{4}) (\d{2}):(\d{2}):(\d{2}) (A|P)`, regexp2.IgnoreCase)

var nil_time = time.Time{}

func Date(ts_str string) (time.Time, error) {
	ts_match, ts_match_err := ts_re.FindStringMatch(ts_str)
	if ts_match_err != nil {
		return nil_time, ts_match_err
	}

	ts_gps := ts_match.Groups()
	if ts_gps == nil {
		return nil_time, fmt.Errorf("No groups found")
	}

	year, year_err := strconv.Atoi(ts_gps[3].String())
	if year_err != nil {
		return nil_time, year_err
	}
	month_str := ts_gps[1].String()
	month, month_exists := MapMonth(month_str)
	if !month_exists {
		return nil_time, fmt.Errorf("Month %s not found", month_str)
	}
	day, day_err := strconv.Atoi(ts_gps[2].String())
	if day_err != nil {
		return nil_time, day_err
	}
	hour, hour_err := strconv.Atoi(ts_gps[4].String())
	if hour_err != nil {
		return nil_time, hour_err
	}
	minute, minute_err := strconv.Atoi(ts_gps[5].String())
	if minute_err != nil {
		return nil_time, minute_err
	}
	second, second_err := strconv.Atoi(ts_gps[6].String())
	if second_err != nil {
		return nil_time, second_err
	}
	a_or_p := ts_gps[7].String()
	if a_or_p == "P" && hour < 12 {
		hour += 12
	}
	return time.Date(
		year,
		time.Month(month),
		day,
		hour,
		minute,
		second,
		0,
		time.UTC,
	), nil
}

func FormatMs(ms float64) string {
	second_f := ms / 1000
	minute := int64(second_f / 60)
	second := int64(second_f) % 60

	ms_str := strconv.FormatFloat(ms/1000, 'f', 2, 64) + "s"
	has_minute := minute > 0
	has_second := second > 0
	if has_minute || has_second {
		ms_str += " ("
		if has_minute {
			ms_str += strconv.FormatInt(minute, 10) + "min"
			if minute > 1 {
				ms_str += "s"
			}
		}
		if has_minute && has_second {
			ms_str += " "
		}
		if has_second {
			ms_str += strconv.FormatInt(second, 10) + "s"
		}
		ms_str += ")"
	}

	return ms_str
}

func MapMonth(month_str string) (uint8, bool) {
	var month uint8
	month_exists := true
	switch month_str {
	case "Jan":
		month = 1
	case "Feb":
		month = 2
	case "Mar":
		month = 3
	case "Apr":
		month = 4
	case "May":
		month = 5
	case "Jun":
		month = 6
	case "Jul":
		month = 7
	case "Aug":
		month = 8
	case "Sep":
		month = 9
	case "Oct":
		month = 10
	case "Nov":
		month = 11
	case "Dec":
		month = 12
	default:
		month = 0
		month_exists = false
	}
	return month, month_exists
}
