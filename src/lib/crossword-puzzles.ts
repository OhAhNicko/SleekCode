import type { CrosswordPuzzle } from "../types";

/**
 * Pre-built tech-themed crossword puzzles.
 * Grid: '#' = black cell, letter = fillable white cell.
 * Clues: number = cell number label, row/col = 0-indexed position of first letter.
 */
export const CROSSWORD_PUZZLES: CrosswordPuzzle[] = [
  // Puzzle 1: Web Basics
  {
    id: "web-basics-1",
    grid: [
      ["A","P","I","#","C","S","S"],
      ["#","#","#","#","O","#","E"],
      ["H","T","M","L","R","#","R"],
      ["#","#","#","#","S","#","V"],
      ["D","N","S","#","#","#","E"],
      ["#","#","#","U","R","L","R"],
      ["J","S","O","N","#","#","#"],
    ],
    clues: {
      across: [
        { number: 1, clue: "RESTful interface for web services", answer: "API", row: 0, col: 0 },
        { number: 4, clue: "Stylesheet language for the web", answer: "CSS", row: 0, col: 4 },
        { number: 6, clue: "Markup language for web pages", answer: "HTML", row: 2, col: 0 },
        { number: 8, clue: "Domain name resolution system", answer: "DNS", row: 4, col: 0 },
        { number: 10, clue: "Web address that locates a resource", answer: "URL", row: 5, col: 3 },
        { number: 11, clue: "Lightweight data interchange format", answer: "JSON", row: 6, col: 0 },
      ],
      down: [
        { number: 2, clue: "Cross-origin resource sharing", answer: "CORS", row: 0, col: 4 },
        { number: 3, clue: "Handles HTTP requests from clients", answer: "SERVER", row: 0, col: 6 },
        { number: 5, clue: "Hypertext transfer protocol", answer: "HTTP", row: 2, col: 0 },
        { number: 7, clue: "HyperText Markup Language", answer: "HTML", row: 2, col: 0 },
        { number: 9, clue: "Document object model", answer: "DOM", row: 4, col: 0 },
      ],
    },
  },
  // Puzzle 2: DevOps
  {
    id: "devops-2",
    grid: [
      ["D","O","C","K","E","R","#"],
      ["#","#","I","#","#","#","#"],
      ["N","O","D","E","#","G","I"],
      ["#","#","#","#","#","I","#"],
      ["B","A","S","H","#","T","#"],
      ["#","#","S","#","#","#","#"],
      ["Y","A","M","L","#","S","H"],
    ],
    clues: {
      across: [
        { number: 1, clue: "Container runtime platform", answer: "DOCKER", row: 0, col: 0 },
        { number: 3, clue: "JavaScript runtime environment", answer: "NODE", row: 2, col: 0 },
        { number: 5, clue: "Unix shell and command language", answer: "BASH", row: 4, col: 0 },
        { number: 7, clue: "Human-readable data serialization", answer: "YAML", row: 6, col: 0 },
        { number: 8, clue: "Secure remote access protocol", answer: "SH", row: 6, col: 5 },
      ],
      down: [
        { number: 1, clue: "Continuous integration/deployment tool", answer: "CICD", row: 0, col: 2 },
        { number: 2, clue: "Version control tool by Linus", answer: "GIT", row: 2, col: 5 },
        { number: 4, clue: "Secure Shell shorthand", answer: "SSH", row: 4, col: 2 },
        { number: 6, clue: "GitHub Actions runs on this", answer: "GI", row: 2, col: 6 },
      ],
    },
  },
  // Puzzle 3: Programming Languages
  {
    id: "lang-3",
    grid: [
      ["R","U","S","T","#","G","O"],
      ["#","#","#","Y","#","#","#"],
      ["S","W","I","P","E","#","#"],
      ["#","#","#","E","#","#","#"],
      ["J","A","V","A","#","#","#"],
      ["#","#","#","#","L","U","A"],
      ["#","#","C","P","P","#","#"],
    ],
    clues: {
      across: [
        { number: 1, clue: "Memory-safe systems language by Mozilla", answer: "RUST", row: 0, col: 0 },
        { number: 2, clue: "Google's concurrent language", answer: "GO", row: 0, col: 5 },
        { number: 4, clue: "Mobile gesture action", answer: "SWIPE", row: 2, col: 0 },
        { number: 6, clue: "Write once, run anywhere language", answer: "JAVA", row: 4, col: 0 },
        { number: 7, clue: "Lightweight embeddable scripting lang", answer: "LUA", row: 5, col: 4 },
        { number: 8, clue: "C with classes (abbreviation)", answer: "CPP", row: 6, col: 2 },
      ],
      down: [
        { number: 1, clue: "Statically typed superset of JS", answer: "TYPESCRIPT", row: 0, col: 3 },
        { number: 3, clue: "Apple's modern programming language", answer: "SWIFT", row: 2, col: 0 },
        { number: 5, clue: "High-level interpreted language", answer: "JAVA", row: 4, col: 0 },
      ],
    },
  },
  // Puzzle 4: Data Structures
  {
    id: "data-4",
    grid: [
      ["S","T","A","C","K","#","#"],
      ["#","R","#","#","#","#","#"],
      ["H","E","A","P","#","#","#"],
      ["#","E","#","#","N","O","D"],
      ["#","#","Q","U","E","U","E"],
      ["#","M","A","P","#","#","#"],
      ["#","#","R","#","S","E","T"],
    ],
    clues: {
      across: [
        { number: 1, clue: "LIFO data structure", answer: "STACK", row: 0, col: 0 },
        { number: 3, clue: "Priority queue backing structure", answer: "HEAP", row: 2, col: 0 },
        { number: 5, clue: "Element in a linked list", answer: "NOD", row: 3, col: 4 },
        { number: 6, clue: "FIFO data structure", answer: "QUEUE", row: 4, col: 2 },
        { number: 7, clue: "Key-value collection", answer: "MAP", row: 5, col: 1 },
        { number: 8, clue: "Unique elements collection", answer: "SET", row: 6, col: 4 },
      ],
      down: [
        { number: 1, clue: "Hierarchical data structure", answer: "TREE", row: 0, col: 1 },
        { number: 2, clue: "Fixed-size sequential collection", answer: "ARRAY", row: 0, col: 2 },
        { number: 4, clue: "Vertex in a graph or tree", answer: "NODE", row: 3, col: 4 },
      ],
    },
  },
  // Puzzle 5: Database Terms
  {
    id: "db-5",
    grid: [
      ["Q","U","E","R","Y","#","#"],
      ["#","#","#","O","#","#","#"],
      ["I","N","D","E","X","#","#"],
      ["#","#","#","W","#","#","#"],
      ["J","O","I","N","#","S","Q"],
      ["#","#","#","#","#","#","L"],
      ["#","T","A","B","L","E","#"],
    ],
    clues: {
      across: [
        { number: 1, clue: "SQL statement to fetch data", answer: "QUERY", row: 0, col: 0 },
        { number: 3, clue: "Speed up lookups in a database", answer: "INDEX", row: 2, col: 0 },
        { number: 5, clue: "Combine rows from two tables", answer: "JOIN", row: 4, col: 0 },
        { number: 6, clue: "Structured query language", answer: "SQL", row: 4, col: 5 },
        { number: 7, clue: "Rows and columns storage unit", answer: "TABLE", row: 6, col: 1 },
      ],
      down: [
        { number: 2, clue: "Single entry in a table", answer: "ROW", row: 0, col: 3 },
        { number: 4, clue: "Column that uniquely identifies a row", answer: "ID", row: 2, col: 0 },
      ],
    },
  },
  // Puzzle 6: Git Terms
  {
    id: "git-6",
    grid: [
      ["M","E","R","G","E","#","#"],
      ["#","#","E","#","#","#","#"],
      ["P","U","S","H","#","#","#"],
      ["#","#","E","#","T","A","G"],
      ["#","#","T","#","#","#","#"],
      ["C","L","O","N","E","#","#"],
      ["#","#","#","#","D","I","F"],
    ],
    clues: {
      across: [
        { number: 1, clue: "Combine two branches", answer: "MERGE", row: 0, col: 0 },
        { number: 3, clue: "Upload commits to remote", answer: "PUSH", row: 2, col: 0 },
        { number: 5, clue: "Label a specific commit", answer: "TAG", row: 3, col: 4 },
        { number: 6, clue: "Copy a remote repository", answer: "CLONE", row: 5, col: 0 },
        { number: 7, clue: "Show changes between commits", answer: "DIF", row: 6, col: 4 },
      ],
      down: [
        { number: 2, clue: "Undo a commit with a new commit", answer: "RESET", row: 0, col: 2 },
        { number: 4, clue: "Difference viewer", answer: "EDIT", row: 5, col: 4 },
      ],
    },
  },
  // Puzzle 7: Security
  {
    id: "security-7",
    grid: [
      ["H","A","S","H","#","X","S"],
      ["#","#","S","#","#","#","S"],
      ["T","O","K","E","N","#","L"],
      ["#","#","#","#","#","#","#"],
      ["C","E","R","T","#","#","#"],
      ["#","#","S","A","L","T","#"],
      ["A","U","T","H","#","#","#"],
    ],
    clues: {
      across: [
        { number: 1, clue: "One-way function for passwords", answer: "HASH", row: 0, col: 0 },
        { number: 2, clue: "Cross-site scripting attack", answer: "XSS", row: 0, col: 5 },
        { number: 4, clue: "Bearer ___ for API authentication", answer: "TOKEN", row: 2, col: 0 },
        { number: 5, clue: "Digital certificate for HTTPS", answer: "CERT", row: 4, col: 0 },
        { number: 6, clue: "Random data added before hashing", answer: "SALT", row: 5, col: 2 },
        { number: 7, clue: "Authentication (short form)", answer: "AUTH", row: 6, col: 0 },
      ],
      down: [
        { number: 1, clue: "Secure Sockets Layer", answer: "SSL", row: 0, col: 6 },
        { number: 3, clue: "Secure Shell for remote access", answer: "SSH", row: 0, col: 2 },
      ],
    },
  },
  // Puzzle 8: Cloud & Infra
  {
    id: "cloud-8",
    grid: [
      ["A","W","S","#","#","#","#"],
      ["#","#","#","P","O","D","#"],
      ["#","H","E","L","M","#","#"],
      ["#","#","#","A","#","L","B"],
      ["#","C","D","N","#","#","#"],
      ["#","#","#","E","C","S","#"],
      ["V","P","C","#","#","#","#"],
    ],
    clues: {
      across: [
        { number: 1, clue: "Amazon's cloud platform", answer: "AWS", row: 0, col: 0 },
        { number: 2, clue: "Smallest deployable unit in K8s", answer: "POD", row: 1, col: 3 },
        { number: 3, clue: "Kubernetes package manager", answer: "HELM", row: 2, col: 1 },
        { number: 5, clue: "Load balancer abbreviation", answer: "LB", row: 3, col: 5 },
        { number: 6, clue: "Content delivery network", answer: "CDN", row: 4, col: 1 },
        { number: 7, clue: "Elastic Container Service", answer: "ECS", row: 5, col: 4 },
        { number: 8, clue: "Virtual private cloud", answer: "VPC", row: 6, col: 0 },
      ],
      down: [
        { number: 4, clue: "Kubernetes management __", answer: "PLANE", row: 1, col: 3 },
      ],
    },
  },
  // Puzzle 9: Frontend Frameworks
  {
    id: "frontend-9",
    grid: [
      ["R","E","A","C","T","#","#"],
      ["#","#","#","#","#","#","#"],
      ["V","I","T","E","#","V","U"],
      ["#","#","#","#","#","#","E"],
      ["S","V","E","L","T","E","#"],
      ["#","#","#","#","S","X","#"],
      ["N","E","X","T","#","#","#"],
    ],
    clues: {
      across: [
        { number: 1, clue: "Facebook's UI library", answer: "REACT", row: 0, col: 0 },
        { number: 2, clue: "Lightning-fast build tool", answer: "VITE", row: 2, col: 0 },
        { number: 3, clue: "Progressive JS framework", answer: "VUE", row: 2, col: 5 },
        { number: 4, clue: "Compile-time framework, no virtual DOM", answer: "SVELTE", row: 4, col: 0 },
        { number: 5, clue: "JSX + TypeScript extension", answer: "TSX", row: 4, col: 4 },
        { number: 6, clue: "React meta-framework by Vercel", answer: "NEXT", row: 6, col: 0 },
      ],
      down: [
        { number: 1, clue: "Vue 3 composition ___", answer: "VUE", row: 2, col: 5 },
      ],
    },
  },
  // Puzzle 10: Linux/Unix
  {
    id: "linux-10",
    grid: [
      ["G","R","E","P","#","#","#"],
      ["#","#","#","I","#","S","U"],
      ["C","A","T","P","E","D","#"],
      ["#","#","#","E","#","#","#"],
      ["A","W","K","#","R","M","#"],
      ["#","#","#","#","#","#","#"],
      ["C","H","M","O","D","#","#"],
    ],
    clues: {
      across: [
        { number: 1, clue: "Search text with regex patterns", answer: "GREP", row: 0, col: 0 },
        { number: 3, clue: "Superuser command prefix", answer: "SU", row: 1, col: 5 },
        { number: 4, clue: "Display file contents command", answer: "CAT", row: 2, col: 0 },
        { number: 5, clue: "Stream editor for text", answer: "SED", row: 2, col: 4 },
        { number: 6, clue: "Pattern scanning language", answer: "AWK", row: 4, col: 0 },
        { number: 7, clue: "Delete files command", answer: "RM", row: 4, col: 4 },
        { number: 8, clue: "Change file permissions", answer: "CHMOD", row: 6, col: 0 },
      ],
      down: [
        { number: 2, clue: "Send data through processes", answer: "PIPE", row: 0, col: 3 },
      ],
    },
  },
  // Puzzle 11: Networking
  {
    id: "network-11",
    grid: [
      ["T","C","P","#","#","#","#"],
      ["#","#","O","R","T","#","#"],
      ["#","#","R","#","#","#","#"],
      ["L","A","T","E","N","C","Y"],
      ["#","#","#","#","#","#","#"],
      ["U","D","P","#","N","A","T"],
      ["#","#","#","P","I","N","G"],
    ],
    clues: {
      across: [
        { number: 1, clue: "Reliable transport protocol", answer: "TCP", row: 0, col: 0 },
        { number: 2, clue: "Network service endpoint number", answer: "PORT", row: 1, col: 2 },
        { number: 4, clue: "Network delay measurement", answer: "LATENCY", row: 3, col: 0 },
        { number: 5, clue: "Fast, connectionless protocol", answer: "UDP", row: 5, col: 0 },
        { number: 6, clue: "Network address translation", answer: "NAT", row: 5, col: 4 },
        { number: 7, clue: "Test host reachability", answer: "PING", row: 6, col: 3 },
      ],
      down: [
        { number: 3, clue: "Where packets travel to", answer: "PORT", row: 0, col: 2 },
      ],
    },
  },
  // Puzzle 12: Testing
  {
    id: "testing-12",
    grid: [
      ["M","O","C","K","#","#","#"],
      ["#","#","#","#","#","#","#"],
      ["S","P","E","C","#","#","#"],
      ["#","#","#","#","J","E","S"],
      ["#","#","L","I","N","T","#"],
      ["#","#","#","#","#","D","D"],
      ["A","S","S","E","R","T","#"],
    ],
    clues: {
      across: [
        { number: 1, clue: "Simulated dependency in tests", answer: "MOCK", row: 0, col: 0 },
        { number: 2, clue: "Test specification file", answer: "SPEC", row: 2, col: 0 },
        { number: 3, clue: "Popular JS test runner", answer: "JES", row: 3, col: 4 },
        { number: 4, clue: "Static code analysis tool", answer: "LINT", row: 4, col: 2 },
        { number: 5, clue: "Test-driven development", answer: "TDD", row: 5, col: 5 },
        { number: 6, clue: "Verify expected outcomes", answer: "ASSERT", row: 6, col: 0 },
      ],
      down: [
        { number: 1, clue: "JavaScript testing framework", answer: "JEST", row: 3, col: 4 },
      ],
    },
  },
  // Puzzle 13: Algorithms
  {
    id: "algo-13",
    grid: [
      ["S","O","R","T","#","#","#"],
      ["#","#","#","R","#","#","#"],
      ["D","F","S","E","E","#","#"],
      ["#","#","#","E","#","#","#"],
      ["B","F","S","#","#","#","#"],
      ["#","#","#","#","#","#","#"],
      ["H","A","S","H","M","A","P"],
    ],
    clues: {
      across: [
        { number: 1, clue: "Arrange elements in order", answer: "SORT", row: 0, col: 0 },
        { number: 3, clue: "Depth-first search", answer: "DFS", row: 2, col: 0 },
        { number: 4, clue: "Breadth-first search", answer: "BFS", row: 4, col: 0 },
        { number: 5, clue: "O(1) lookup data structure", answer: "HASHMAP", row: 6, col: 0 },
      ],
      down: [
        { number: 2, clue: "Hierarchical search structure", answer: "TREE", row: 0, col: 3 },
      ],
    },
  },
  // Puzzle 14: Regex & Patterns
  {
    id: "regex-14",
    grid: [
      ["R","E","G","E","X","#","#"],
      ["#","#","L","#","#","#","#"],
      ["M","A","O","B","#","#","#"],
      ["#","#","B","#","#","#","#"],
      ["F","L","A","G","#","#","#"],
      ["#","#","L","#","#","#","#"],
      ["G","R","E","E","D","Y","#"],
    ],
    clues: {
      across: [
        { number: 1, clue: "Pattern matching language", answer: "REGEX", row: 0, col: 0 },
        { number: 3, clue: "Short for mobile app", answer: "MAOB", row: 2, col: 0 },
        { number: 4, clue: "Regex modifier like /g or /i", answer: "FLAG", row: 4, col: 0 },
        { number: 5, clue: "Matches as much as possible", answer: "GREEDY", row: 6, col: 0 },
      ],
      down: [
        { number: 2, clue: "Matches any character pattern: .*", answer: "GLOBAL", row: 0, col: 2 },
      ],
    },
  },
  // Puzzle 15: CSS Properties
  {
    id: "css-15",
    grid: [
      ["F","L","E","X","#","#","#"],
      ["#","#","#","#","#","#","#"],
      ["G","R","I","D","#","#","#"],
      ["#","#","#","#","#","#","#"],
      ["C","O","L","O","R","#","#"],
      ["#","P","A","D","#","#","#"],
      ["#","#","#","#","#","#","#"],
    ],
    clues: {
      across: [
        { number: 1, clue: "CSS layout model for 1D", answer: "FLEX", row: 0, col: 0 },
        { number: 2, clue: "CSS layout model for 2D", answer: "GRID", row: 2, col: 0 },
        { number: 3, clue: "CSS text appearance property", answer: "COLOR", row: 4, col: 0 },
        { number: 4, clue: "Inner spacing property (short)", answer: "PAD", row: 5, col: 1 },
      ],
      down: [],
    },
  },
  // Puzzle 16: TypeScript
  {
    id: "ts-16",
    grid: [
      ["T","Y","P","E","#","#","#"],
      ["#","#","#","N","U","L","L"],
      ["#","#","#","U","#","#","#"],
      ["V","O","I","M","#","#","#"],
      ["#","#","#","#","A","N","Y"],
      ["#","#","#","#","#","#","#"],
      ["#","#","#","#","#","#","#"],
    ],
    clues: {
      across: [
        { number: 1, clue: "TypeScript keyword for aliases", answer: "TYPE", row: 0, col: 0 },
        { number: 2, clue: "Absence of value", answer: "NULL", row: 1, col: 3 },
        { number: 3, clue: "Function returns nothing", answer: "VOID", row: 3, col: 0 },
        { number: 4, clue: "Escape hatch type in TS", answer: "ANY", row: 4, col: 4 },
      ],
      down: [
        { number: 1, clue: "Numeric ___ type", answer: "ENUM", row: 0, col: 3 },
      ],
    },
  },
  // Puzzle 17: Package Managers
  {
    id: "pkg-17",
    grid: [
      ["N","P","M","#","#","#","#"],
      ["#","#","#","Y","A","R","N"],
      ["P","I","P","#","#","#","#"],
      ["#","#","N","P","X","#","#"],
      ["#","#","#","#","#","#","#"],
      ["B","R","E","W","#","#","#"],
      ["#","C","A","R","G","O","#"],
    ],
    clues: {
      across: [
        { number: 1, clue: "Node package manager", answer: "NPM", row: 0, col: 0 },
        { number: 2, clue: "Fast, reliable JS package manager", answer: "YARN", row: 1, col: 3 },
        { number: 3, clue: "Python package installer", answer: "PIP", row: 2, col: 0 },
        { number: 4, clue: "Execute npm packages without install", answer: "NPX", row: 3, col: 2 },
        { number: 5, clue: "macOS package manager", answer: "BREW", row: 5, col: 0 },
        { number: 6, clue: "Rust package manager", answer: "CARGO", row: 6, col: 1 },
      ],
      down: [],
    },
  },
  // Puzzle 18: Design Patterns
  {
    id: "patterns-18",
    grid: [
      ["M","V","C","#","#","#","#"],
      ["#","#","#","#","#","#","#"],
      ["C","R","U","D","#","#","#"],
      ["#","#","#","R","#","#","#"],
      ["R","E","S","T","#","#","#"],
      ["#","#","#","#","O","R","M"],
      ["#","#","S","P","A","#","#"],
    ],
    clues: {
      across: [
        { number: 1, clue: "Model-View-Controller pattern", answer: "MVC", row: 0, col: 0 },
        { number: 2, clue: "Create, Read, Update, Delete", answer: "CRUD", row: 2, col: 0 },
        { number: 3, clue: "Representational State Transfer", answer: "REST", row: 4, col: 0 },
        { number: 4, clue: "Object-relational mapping", answer: "ORM", row: 5, col: 4 },
        { number: 5, clue: "Single page application", answer: "SPA", row: 6, col: 2 },
      ],
      down: [
        { number: 1, clue: "Don't repeat yourself", answer: "DRY", row: 2, col: 3 },
      ],
    },
  },
  // Puzzle 19: Concurrency
  {
    id: "concurrency-19",
    grid: [
      ["M","U","T","E","X","#","#"],
      ["#","#","#","#","#","#","#"],
      ["A","S","Y","N","C","#","#"],
      ["#","#","#","#","#","#","#"],
      ["A","W","A","I","T","#","#"],
      ["#","#","#","#","#","#","#"],
      ["L","O","C","K","#","#","#"],
    ],
    clues: {
      across: [
        { number: 1, clue: "Mutual exclusion primitive", answer: "MUTEX", row: 0, col: 0 },
        { number: 2, clue: "Non-blocking execution mode", answer: "ASYNC", row: 2, col: 0 },
        { number: 3, clue: "Wait for a promise to resolve", answer: "AWAIT", row: 4, col: 0 },
        { number: 4, clue: "Prevent concurrent access", answer: "LOCK", row: 6, col: 0 },
      ],
      down: [],
    },
  },
  // Puzzle 20: AI/ML Basics
  {
    id: "ai-ml-20",
    grid: [
      ["G","P","T","#","#","#","#"],
      ["#","#","#","L","L","M","#"],
      ["#","R","A","G","#","#","#"],
      ["#","#","#","#","#","#","#"],
      ["B","E","R","T","#","#","#"],
      ["#","#","#","#","#","#","#"],
      ["N","L","P","#","#","#","#"],
    ],
    clues: {
      across: [
        { number: 1, clue: "Generative Pre-trained Transformer", answer: "GPT", row: 0, col: 0 },
        { number: 2, clue: "Large language model abbreviation", answer: "LLM", row: 1, col: 3 },
        { number: 3, clue: "Retrieval-augmented generation", answer: "RAG", row: 2, col: 1 },
        { number: 4, clue: "Google's bidirectional model", answer: "BERT", row: 4, col: 0 },
        { number: 5, clue: "Natural language processing", answer: "NLP", row: 6, col: 0 },
      ],
      down: [],
    },
  },
];
