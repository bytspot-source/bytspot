package store

import (
	"strconv"
	"sync"
	"time"
)

type ServiceOption string

const (
	ServiceWashBasic  ServiceOption = "basic_wash"
	ServiceDetailFull ServiceOption = "full_detail"
	ServiceEVCharge   ServiceOption = "ev_charging"
)

type Vehicle struct {
	Make  string `json:"make"`
	Model string `json:"model"`
	Plate string `json:"plate"`
	Color string `json:"color"`
}

type TicketStatus string

const (
	StatusIntake    TicketStatus = "intake"
	StatusParked    TicketStatus = "parked"
	StatusService   TicketStatus = "service_in_progress"
	StatusReady     TicketStatus = "ready"
	StatusRetrieved TicketStatus = "retrieved"
)

type Ticket struct {
	ID        string          `json:"id"`
	UserID    string          `json:"userId"`
	CreatedAt time.Time       `json:"createdAt"`
	Vehicle   Vehicle         `json:"vehicle"`
	Spot      string          `json:"spot"`
	Services  []ServiceOption `json:"services"`
	Photos    []string        `json:"photos"`
	Status    TicketStatus    `json:"status"`
	UpdatedAt time.Time       `json:"updatedAt"`
}

type Store struct {
	mu      sync.RWMutex
	seq     int
	tickets map[string]*Ticket
}

func New() *Store { return &Store{tickets: map[string]*Ticket{}} }

func (s *Store) nextID() string {
	s.seq++
	return "vt" + time.Now().Format("20060102150405") + "-" + strconv.Itoa(s.seq)
}

func (s *Store) CreateTicket(t *Ticket) *Ticket {
	s.mu.Lock()
	defer s.mu.Unlock()
	if t.ID == "" {
		t.ID = s.nextID()
	}
	now := time.Now()
	t.CreatedAt = now
	t.UpdatedAt = now
	s.tickets[t.ID] = t
	return t
}

func (s *Store) UpdateStatus(id string, status TicketStatus) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if t, ok := s.tickets[id]; ok {
		t.Status = status
		t.UpdatedAt = time.Now()
		return true
	}
	return false
}

func (s *Store) Get(id string) (*Ticket, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	t, ok := s.tickets[id]
	return t, ok
}

func (s *Store) List() []*Ticket {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make([]*Ticket, 0, len(s.tickets))
	for _, t := range s.tickets {
		out = append(out, t)
	}
	return out
}
