package security

import (
	"reflect"
	"strings"
)

const Redacted = "[REDACTED]"

func RedactValue(value any) any {
	return redactReflect(reflect.ValueOf(value), "")
}

func redactReflect(value reflect.Value, fieldName string) any {
	if isSensitiveName(fieldName) {
		return Redacted
	}
	if !value.IsValid() {
		return nil
	}
	if value.Kind() == reflect.Interface || value.Kind() == reflect.Pointer {
		if value.IsNil() {
			return nil
		}
		return redactReflect(value.Elem(), fieldName)
	}
	switch value.Kind() {
	case reflect.Map:
		result := make(map[string]any, value.Len())
		iterator := value.MapRange()
		for iterator.Next() {
			key := iterator.Key()
			name := ""
			if key.Kind() == reflect.String {
				name = key.String()
			} else {
				name = strings.TrimSpace(reflect.ValueOf(key.Interface()).String())
			}
			result[name] = redactReflect(iterator.Value(), name)
		}
		return result
	case reflect.Slice, reflect.Array:
		result := make([]any, value.Len())
		for i := range result {
			result[i] = redactReflect(value.Index(i), "")
		}
		return result
	case reflect.Struct:
		result := make(map[string]any, value.NumField())
		typeOf := value.Type()
		for i := 0; i < value.NumField(); i++ {
			field := typeOf.Field(i)
			if !field.IsExported() {
				continue
			}
			name := field.Name
			if jsonName := strings.Split(field.Tag.Get("json"), ",")[0]; jsonName != "" && jsonName != "-" {
				name = jsonName
			}
			result[name] = redactReflect(value.Field(i), name)
		}
		return result
	default:
		return value.Interface()
	}
}

func isSensitiveName(name string) bool {
	normalized := strings.ToLower(strings.ReplaceAll(strings.ReplaceAll(name, "-", "_"), ".", "_"))
	for _, marker := range []string{"password", "secret", "token", "credential", "private_key", "authorization", "cookie"} {
		if strings.Contains(normalized, marker) {
			return true
		}
	}
	return false
}
